import type { CreateScheduleInput, UpdateScheduleInput } from '@smart-campus/validation';
import type { Prisma } from '@prisma/client';
import { AppError, conflict, forbidden, notFound } from '../../../lib/errors.js';
import { prisma } from '../../../lib/prisma.js';
import { audit } from '../../audit/application/auditService.js';
import type { Actor } from '../../assessments/application/assessmentService.js';

/**
 * Cliente Prisma aceito nas consultas do módulo: o client normal ou a
 * transação ($transaction) — permite que validações e escritas encontrem os
 * mesmos dados dentro da mesma transação.
 */
type ScheduleDb = Prisma.TransactionClient | typeof prisma;

/** Chave do advisory lock dos horários — serializa verificações de sobreposição. */
const SCHEDULE_ADVISORY_LOCK_KEY = 'class_schedule';

type ScheduleRecord = {
  id: string;
  title: string;
  subjectId: string;
  courseId: string;
  teacherId: string | null;
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  updatedAt: Date;
  subject?: { id: string; code: string; name: string };
  course?: { id: string; code: string; name: string };
  teacher?: { id: string; fullName: string } | null;
};

type ScheduleDto = ReturnType<typeof mapSchedule>;
type RoomRef = { id: string; code: string; name: string };

function mapSchedule(s: ScheduleRecord) {
  return {
    id: s.id,
    title: s.title,
    subjectId: s.subjectId,
    subject: s.subject,
    courseId: s.courseId,
    course: s.course,
    teacherId: s.teacherId,
    teacher: s.teacher ?? null,
    roomId: s.roomId,
    room: null as RoomRef | null,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

const scheduleInclude = {
  subject: { select: { id: true, code: true, name: true } },
  course: { select: { id: true, code: true, name: true } },
  teacher: { select: { id: true, fullName: true } },
} as const;

/**
 * ClassSchedule.roomId não tem relação Prisma (é uma referência solta), pelo que
 * a sala é resolvida numa segunda consulta e anexada ao DTO.
 */
async function resolveRooms(roomIds: (string | null)[]): Promise<Map<string, RoomRef>> {
  const unique = [...new Set(roomIds.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rooms = await prisma.room.findMany({
    where: { id: { in: unique } },
    select: { id: true, code: true, name: true },
  });
  return new Map(rooms.map((room) => [room.id, room]));
}

function withRooms(schedules: ScheduleDto[], rooms: Map<string, RoomRef>): ScheduleDto[] {
  return schedules.map((schedule) =>
    schedule.roomId ? { ...schedule, room: rooms.get(schedule.roomId) ?? null } : schedule,
  );
}

async function assertScheduleWriteAccess(actor: Actor) {
  if (actor.role !== 'COORDINATOR' && actor.role !== 'ADMIN') {
    throw forbidden('Apenas coordenador ou administrador gere horários', 'FORBIDDEN');
  }
}

export type ScheduleFilters = {
  studentId?: string;
  courseId?: string;
  subjectId?: string;
  teacherId?: string;
  roomId?: string;
  from?: Date;
  to?: Date;
};

/**
 * GET /schedules — contrato G3.
 * STUDENT: horários do próprio curso; um ?studentId de outro estudante → 403 (anti-BOLA).
 * TEACHER: sessões em que é docente.
 * COORDINATOR/ADMIN: todos, com filtro opcional por studentId (resolve StudentProfile → curso).
 * Em qualquer papel, os filtros opcionais apenas restringem o resultado — nunca ampliam o acesso.
 */
export async function listSchedules(actor: Actor, filters: ScheduleFilters = {}) {
  const scope: Record<string, unknown>[] = [];

  if (actor.role === 'STUDENT') {
    const profile = await prisma.studentProfile.findUnique({ where: { userId: actor.id } });
    if (!profile) throw notFound('STUDENT_PROFILE_NOT_FOUND', 'Perfil de estudante não encontrado');
    if (filters.studentId && filters.studentId !== profile.id) {
      throw forbidden('Um estudante só pode consultar os seus próprios horários', 'FORBIDDEN');
    }
    if (!profile.courseId) return [];
    scope.push({ courseId: profile.courseId });
  } else if (actor.role === 'TEACHER') {
    scope.push({ teacherId: actor.id });
  } else if (filters.studentId) {
    const profile = await prisma.studentProfile.findUnique({ where: { id: filters.studentId } });
    if (!profile) throw notFound('STUDENT_NOT_FOUND', 'Estudante não encontrado');
    scope.push(profile.courseId ? { courseId: profile.courseId } : { id: '__none__' });
  }

  const filter: Record<string, unknown> = {};
  if (filters.courseId) filter.courseId = filters.courseId;
  if (filters.subjectId) filter.subjectId = filters.subjectId;
  if (filters.teacherId) filter.teacherId = filters.teacherId;
  if (filters.roomId) filter.roomId = filters.roomId;
  if (filters.from || filters.to) {
    filter.startsAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  const conditions = Object.keys(filter).length > 0 ? [...scope, filter] : scope;

  const schedules = await prisma.classSchedule.findMany({
    where: conditions.length > 0 ? { AND: conditions } : {},
    include: scheduleInclude,
    orderBy: { startsAt: 'asc' },
  });

  const mapped = schedules.map(mapSchedule);
  const rooms = await resolveRooms(mapped.map((s) => s.roomId));
  return withRooms(mapped, rooms);
}

/**
 * GET /schedules/options — dados de referência para o formulário de gestão.
 * Restrito a quem pode escrever (COORDINATOR/ADMIN), pelo que não expõe
 * docentes ou salas a papéis sem permissão de gestão.
 */
export async function listScheduleOptions(actor: Actor) {
  await assertScheduleWriteAccess(actor);

  const [courses, subjects, teachers, rooms] = await Promise.all([
    prisma.course.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true },
    }),
    prisma.subject.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, courseId: true },
    }),
    prisma.user.findMany({
      where: { isActive: true, role: { code: 'TEACHER' } },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true },
    }),
    prisma.room.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true },
    }),
  ]);

  return { courses, subjects, teachers, rooms };
}

async function checkScheduleOverlap(db: ScheduleDb, params: {
  excludeId?: string;
  teacherId?: string | null;
  roomId?: string | null;
  courseId: string;
  startsAt: Date;
  endsAt: Date;
}) {
  const conditions: Record<string, unknown>[] = [
    { startsAt: { lt: params.endsAt } },
    { endsAt: { gt: params.startsAt } },
  ];

  const OR: Record<string, unknown>[] = [];
  if (params.teacherId) OR.push({ teacherId: params.teacherId });
  if (params.roomId) OR.push({ roomId: params.roomId });
  OR.push({ courseId: params.courseId });

  const where: Record<string, unknown> = {
    AND: [...conditions, { OR }],
  };

  if (params.excludeId) {
    (where.AND as Record<string, unknown>[]).push({ id: { not: params.excludeId } });
  }

  const overlapping = await db.classSchedule.findFirst({
    where,
    select: { id: true, title: true, teacherId: true, roomId: true, courseId: true, startsAt: true, endsAt: true },
  });

  if (overlapping) {
    throw conflict(
      'SCHEDULE_OVERLAP',
      'Já existe um horário sobreposto para este docente, sala ou curso no mesmo intervalo',
    );
  }
}

async function validateScheduleRefs(db: ScheduleDb, input: { subjectId: string; courseId: string; teacherId?: string | null; roomId?: string | null }) {
  const subject = await db.subject.findUnique({ where: { id: input.subjectId } });
  if (!subject) throw notFound('SUBJECT_NOT_FOUND', 'Disciplina não encontrada');

  const course = await db.course.findUnique({ where: { id: input.courseId } });
  if (!course) throw notFound('COURSE_NOT_FOUND', 'Curso não encontrado');

  if (subject.courseId !== course.id) {
    throw conflict('SUBJECT_COURSE_MISMATCH', 'A disciplina não pertence ao curso indicado');
  }

  if (input.teacherId) {
    const teacherUser = await db.user.findUnique({ where: { id: input.teacherId }, include: { role: true } });
    if (!teacherUser) throw notFound('TEACHER_NOT_FOUND', 'Docente não encontrado');
    if (teacherUser.role.code !== 'TEACHER') {
      throw conflict('TEACHER_ROLE_MISMATCH', 'O utilizador indicado não tem role TEACHER');
    }
  }

  if (input.roomId) {
    const room = await db.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw notFound('ROOM_NOT_FOUND', 'Sala não encontrada');
  }
}

export async function createSchedule(input: CreateScheduleInput, actor: Actor, correlationId: string) {
  await assertScheduleWriteAccess(actor);

  const schedule = await prisma.$transaction(async (tx) => {
    // Serializa a verificação de sobreposição com a escrita: sem o lock, duas
    // requisições simultâneas podem ambas passar no findFirst e gravar sessões
    // sobrepostas (race condition read-then-write).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SCHEDULE_ADVISORY_LOCK_KEY}))`;

    await validateScheduleRefs(tx, input);

    await checkScheduleOverlap(tx, {
      teacherId: input.teacherId ?? null,
      roomId: input.roomId ?? null,
      courseId: input.courseId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });

    return tx.classSchedule.create({
      data: {
        title: input.title,
        subjectId: input.subjectId,
        courseId: input.courseId,
        teacherId: input.teacherId ?? null,
        roomId: input.roomId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
      include: scheduleInclude,
    });
  });

  await audit({
    action: 'SCHEDULE_CREATE',
    resource: 'ClassSchedule',
    resourceId: schedule.id,
    actorId: actor.id,
    correlationId,
    metadata: { title: schedule.title, subjectId: schedule.subjectId, courseId: schedule.courseId },
  });

  const mapped = mapSchedule(schedule);
  const rooms = await resolveRooms([mapped.roomId]);
  return withRooms([mapped], rooms)[0];
}

export async function updateSchedule(id: string, input: UpdateScheduleInput, actor: Actor, correlationId: string) {
  await assertScheduleWriteAccess(actor);

  const existing = await prisma.classSchedule.findUnique({ where: { id } });
  if (!existing) throw notFound('SCHEDULE_NOT_FOUND', 'Horário não encontrado');

  const subjectId = input.subjectId ?? existing.subjectId;
  const courseId = input.courseId ?? existing.courseId;
  const teacherId = input.teacherId === undefined ? existing.teacherId : input.teacherId;
  const roomId = input.roomId === undefined ? existing.roomId : input.roomId;
  const startsAt = input.startsAt ?? existing.startsAt;
  const endsAt = input.endsAt ?? existing.endsAt;

  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new AppError('VALIDATION_ERROR', 'endsAt deve ser posterior a startsAt', 400);
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SCHEDULE_ADVISORY_LOCK_KEY}))`;

    await validateScheduleRefs(tx, {
      subjectId,
      courseId,
      teacherId,
      roomId,
    });

    await checkScheduleOverlap(tx, {
      excludeId: id,
      teacherId,
      roomId,
      courseId,
      startsAt,
      endsAt,
    });

    return tx.classSchedule.update({
      where: { id },
      data: {
        title: input.title,
        subjectId: input.subjectId,
        courseId: input.courseId,
        teacherId: input.teacherId === undefined ? undefined : input.teacherId,
        roomId: input.roomId === undefined ? undefined : input.roomId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
      include: scheduleInclude,
    });
  });

  const schedule = await prisma.classSchedule.findUniqueOrThrow({
    where: { id },
    include: scheduleInclude,
  });

  await audit({
    action: 'SCHEDULE_UPDATE',
    resource: 'ClassSchedule',
    resourceId: schedule.id,
    actorId: actor.id,
    correlationId,
    metadata: { title: schedule.title },
  });

  const mapped = mapSchedule(schedule);
  const rooms = await resolveRooms([mapped.roomId]);
  return withRooms([mapped], rooms)[0];
}

export async function deleteSchedule(id: string, actor: Actor, correlationId: string) {
  await assertScheduleWriteAccess(actor);

  const existing = await prisma.classSchedule.findUnique({ where: { id } });
  if (!existing) throw notFound('SCHEDULE_NOT_FOUND', 'Horário não encontrado');

  await prisma.classSchedule.delete({ where: { id } });

  await audit({
    action: 'SCHEDULE_DELETE',
    resource: 'ClassSchedule',
    resourceId: id,
    actorId: actor.id,
    correlationId,
    metadata: { title: existing.title },
  });

  return { id };
}
