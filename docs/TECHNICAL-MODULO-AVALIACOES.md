# Documentacao Tecnica - Modulo de Avaliacoes, Horarios e Assiduidade (Grupo 3)

**Sistema:** UniversityCampusSystem (Smart Campus) · **Modulo:** `assessments` (`campusModules.key = assessments`) · **Grupo:** G3 · **Versao:** 2026-11

---

## 1. Visao geral

O modulo cobre o ciclo academico de uma disciplina: criacao de avaliacoes (testes, exames, recorrencias), lancamento de notas, calculo da situacao academica (pendente, excluido, admitido ao exame, aprovado/reprovado, dispensado), dispensas (automatica e ao criterio do docente), gestao de horarios e registo de assiduidade. Inclui notificacoes em tempo real (SSE), bloqueio financeiro e proteccao de integridade das pautas.

## 2. Arquitectura

```
apps/api/src/modules/assessments/        -> backend (servico + router)
apps/web/src/pages/AssessmentsPage.tsx   -> UI de gestao (docente/coordenador/admin)
apps/web/src/components/SubjectBoardPanel.tsx -> quadro por disciplina
packages/shared-types, validation, api-client -> contratos partilhados
prisma/schema.prisma -> Subject, Assessment, Grade, SubjectExemption, SubjectEnrolment
```

Consumo de outros modulos: students (StudentProfile), teachers (TeacherProfile), enrolments (SubjectEnrolment - gate para lancamento de notas), financial (FinancialStatus - bloqueio por divida), schedules (ClassSchedule - ligacao docente <-> disciplina), notifications (Notification + SSE).

## 3. Modelo de dados (Prisma)

| Entidade | Campos relevantes |
|---|---|
| Subject | requiredTestCount, recurrenceMinAdmission, exemptionMinGrade, resultsPublishedAt |
| Assessment | subjectId, type (TEST/EXAM/RECURRENCE), weight, gradingMode, maxScore |
| Grade | assessmentId, studentId, value, valuePercent, everNegative, comment |
| SubjectExemption | subjectId, studentId, grade, reason, exemptedById |
| SubjectEnrolment | studentId, subjectId, academicYear, status (PENDING/ACTIVE/CANCELLED/COMPLETED) |

Migracoes relevantes: 20261025174318_estudantes_docentes, 20261030175620_g3_exemption_min_grade, 20261030182411_g3_negativa_permanente.

## 4. Regras de negocio (funcoes puras)

- classifySituacao(finalGrade, hasExam, examComplete) - EXCLUIDO (<=9), APROVADO (10-13), DISPENSADO (>=14).
- computeAcademicState(input) - maquina de estados: PENDENTE -> DISPENSADO/EXCLUIDO -> ADMITIDO_AO_EXAME -> APROVADO_EXAME/REPROVADO_EXAME -> ADMITIDO_RECORRENCIA -> APROVADO/REPROVADO_RECORRENCIA, com RECORRENCIA_EM_REVISAO se o exame for alterado apos a recorrencia.
- computeSubjectFinalResult(...) - nota de admissao (media ponderada), aplicacao da dispensa automatica (admissao >= 14 ou >= exemptionMinGrade, e sem negativa), dispensa manual (sobrepoe calculo).
- Dispensa automatica e vetada por uma unica negativa (Grade.everNegative), mesmo que a nota seja depois corrigida.
- DEFAULT_RECURRENCE_MIN = 7.

## 5. Endpoints (principais)

Base: /api/v1

| Metodo | Rota | Descricao |
|---|---|---|
| GET | /assessments | Listar avaliacoes (staff) |
| POST | /assessments | Criar avaliacao (docente da disciplina) |
| PATCH | /assessments/:id | Editar avaliacao |
| DELETE | /assessments/:id | Eliminar (409 se tem notas ou pauta publicada) |
| GET | /assessments/:id/grades | Roster de notas |
| POST | /assessments/:id/grades | Lancar notas (so inscritos) |
| GET | /assessments/subject/:id/board | Quadro da disciplina |
| PATCH | /assessments/subject/:id/rules | Regras (testes exigidos, minimo recorrencia, nota minima dispensa) |
| POST | /assessments/subject/:id/publish | Publicar/reabrir pauta |
| POST | /assessments/subject/:id/exemptions | Dispensa ao criterio do docente |
| GET | /my/grades | Notas do estudante (bloqueio financeiro) |
| GET | /my/final-grades | Pauta final do estudante (bloqueio financeiro) |
| GET | /notifications/stream?token= | SSE de notificacoes |

RBAC: criacao/lancamento de notas exclusivo do TEACHER atribuido a disciplina (ClassSchedule.teacherId + TeacherProfile ACTIVE). Leitura/edicao de metadados: COORDINATOR/ADMIN.

## 6. Notificacoes em tempo real (SSE)

notificationBus (EventEmitter) + notifyUsers() em createSchedule (estudantes do curso) e upsertGrades (so alterados). SSE GET /notifications/stream?token= com reconexao automatica do EventSource. Frontend useNotifications: 4 estados (connecting/open/error/closed), deduplicacao por id (eco), polling adaptativo (15s desligado / 120s ligado).

## 7. Bloqueio financeiro

assertStudentFinancialStanding(studentId) resolve StudentProfile -> userId (pois FinancialStatus.studentId referencia o User) e lanca FINANCIAL_BLOCKED se status BLOCKED. Aplicado em listStudentGrades e getFinalGrades. Mensagem amigavel: "Deve regularizar a sua situacao financeira para consultar as notas".

## 8. Consumo de modulos

- students: StudentProfile (perfil).
- teachers: TeacherProfile (activo).
- enrolments: SubjectEnrolment - gate para lancamento de notas e para listagem no quadro/roster. Estudante nao inscrito nao aparece e nao recebe nota (STUDENT_NOT_ENROLLED).
- financial: bloqueio por divida.
- schedules: ligacao docente <-> disciplina.

## 9. Testes

- API: 305 passed (Vitest, DB descartavel smart_campus_test).
- Web: 53 passed (Vitest + Testing Library).
- Build: npm run build (API + Web) sem erros.
- Cenarios cobertos: dispensa (minimo + negativa permanente), bloqueio financeiro, deleteAssessment com notas/pauta publicada, enrolment gate, SSE.

## 10. Decisoes e limitacoes

- WebSocket nao implementado: SSE + polling cobrem o requisito; WebSocket e o passo seguinte (infra-estrutura de ligacoes persistentes ainda nao existe no app.ts).
- Broker (RabbitMQ/IBM MQ) nao implementado: EventEmitter in-process e suficiente enquanto as reaccoes nao precisarem de sair do processo (recomendacao das fichas de apoio).
- requiredTestCount null => regra dos 100% de pesos.
