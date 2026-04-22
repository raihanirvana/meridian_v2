export {
  JsonRecordSchema,
  TimestampSchema,
  UlidSchema,
} from "./domain/types/schemas.js";
export { ActorSchema, type Actor } from "./domain/types/enums.js";
export {
  ActionStatusSchema,
  ActionTypeSchema,
  CandidateDecisionSchema,
  CloseReasonSchema,
  CircuitBreakerStateSchema,
  DrawdownStateSchema,
  LessonOutcomeSchema,
  LessonRoleSchema,
  ManagementActionSchema,
  PositionStatusSchema,
  ReconciliationOutcomeSchema,
  StrategySchema,
  type ActionStatus,
  type ActionType,
  type CandidateDecision,
  type CloseReason,
  type CircuitBreakerState,
  type DrawdownState,
  type LessonOutcome,
  type LessonRole,
  type ManagementAction,
  type PositionStatus,
  type ReconciliationOutcome,
  type Strategy,
} from "./domain/types/enums.js";
export {
  ActionSchema,
  type Action,
} from "./domain/entities/Action.js";
export {
  CandidateSchema,
  type Candidate,
} from "./domain/entities/Candidate.js";
export {
  JournalEventSchema,
  type JournalEvent,
} from "./domain/entities/JournalEvent.js";
export {
  LessonSchema,
  type Lesson,
} from "./domain/entities/Lesson.js";
export {
  PortfolioStateSchema,
  type PortfolioState,
} from "./domain/entities/PortfolioState.js";
export {
  PerformanceRecordSchema,
  type PerformanceRecord,
} from "./domain/entities/PerformanceRecord.js";
export {
  PositionSchema,
  type Position,
} from "./domain/entities/Position.js";
export {
  ACTION_LIFECYCLE,
  canTransitionActionStatus,
  transitionActionStatus,
} from "./domain/stateMachines/actionLifecycle.js";
export {
  POSITION_LIFECYCLE,
  canTransitionPositionStatus,
  transitionPositionStatus,
} from "./domain/stateMachines/positionLifecycle.js";
export {
  buildContextString,
  classifyOutcome,
  collectTags,
  deriveLesson,
  inferRoleTags,
  isSuspiciousUnitMix,
  pickRuleTemplate,
} from "./domain/rules/lessonRules.js";
export {
  defaultLessonCaps,
  formatLessonsPrompt,
  ROLE_TAGS,
  selectLessonsForRole,
  type LessonPromptCaps,
  type SelectedLessonsForRole,
} from "./domain/rules/lessonPromptRules.js";
export {
  evaluateManagementAction,
  ManagementEvaluationInputSchema,
  ManagementEvaluationResultSchema,
  ManagementPolicySchema,
  ManagementSignalsSchema,
  type ManagementEvaluationInput,
  type ManagementEvaluationResult,
  type ManagementPolicy,
  type ManagementSignals,
} from "./domain/rules/managementRules.js";
export {
  buildPortfolioRiskStateSnapshot,
  calculateCapitalUsage,
  calculateDailyLossPct,
  deriveCircuitBreakerState,
  deriveDrawdownState,
  evaluatePortfolioRisk,
  PortfolioRiskActionSchema,
  PortfolioRiskEvaluationInputSchema,
  PortfolioRiskEvaluationResultSchema,
  PortfolioRiskPolicySchema,
  PortfolioRiskStateSnapshotSchema,
  updatePortfolioDailyRiskState,
  type CapitalUsageSnapshot,
  type PortfolioRiskAction,
  type PortfolioRiskEvaluationInput,
  type PortfolioRiskEvaluationResult,
  type PortfolioRiskPolicy,
  type PortfolioRiskStateSnapshot,
} from "./domain/rules/riskRules.js";
export {
  evaluateScreeningHardFilters,
  HardFilterEvaluationSchema,
  screenAndScoreCandidates,
  ScreenAndScoreCandidatesResultSchema,
  ScreeningPolicySchema,
  type HardFilterEvaluation,
  type ScreenAndScoreCandidatesResult,
  type ScreeningPolicy,
} from "./domain/rules/screeningRules.js";
export {
  MANAGEMENT_PRIORITY_SCORES,
  ManagementPrioritySchema,
  type ManagementPriority,
} from "./domain/scoring/managementPriority.js";
export {
  CandidateScoreBreakdownSchema,
  CandidateScorePolicySchema,
  CandidateScoreResultSchema,
  scoreCandidate,
  ScreeningCandidateInputSchema,
  type CandidateScoreBreakdown,
  type CandidateScorePolicy,
  type CandidateScoreResult,
  type ScreeningCandidateInput,
} from "./domain/scoring/candidateScore.js";
export {
  FileStore,
  type FileStoreOptions,
  type FileSystemAdapter,
} from "./adapters/storage/FileStore.js";
export {
  AdapterHttpStatusError,
  AdapterResponseValidationError,
  AdapterTransportError,
  JsonHttpClient,
  type FetchLike,
  type JsonHttpClientOptions,
  type JsonHttpRequestOptions,
} from "./adapters/http/HttpJsonClient.js";
export {
  MockDlmmGateway,
  ClaimFeesRequestSchema,
  ClaimFeesResultSchema,
  type ClaimFeesRequest,
  type ClaimFeesResult,
  ClosePositionRequestSchema,
  ClosePositionResultSchema,
  type ClosePositionRequest,
  type ClosePositionResult,
  DeployLiquidityRequestSchema,
  DeployLiquidityResultSchema,
  PartialClosePositionRequestSchema,
  PartialClosePositionResultSchema,
  PoolInfoSchema,
  WalletPositionsSnapshotSchema,
  type DeployLiquidityRequest,
  type DeployLiquidityResult,
  type DlmmGateway,
  type MockDlmmGatewayBehaviors,
  type PartialClosePositionRequest,
  type PartialClosePositionResult,
  type PoolInfo,
  type WalletPositionsSnapshot,
} from "./adapters/dlmm/DlmmGateway.js";
export {
  HttpDlmmGateway,
  type HttpDlmmGatewayOptions,
} from "./adapters/dlmm/HttpDlmmGateway.js";
export {
  MockSwapGateway,
  ExecuteSwapRequestSchema,
  ExecuteSwapResultSchema,
  type ExecuteSwapRequest,
  type ExecuteSwapResult,
  type MockSwapGatewayBehaviors,
  type SwapGateway,
  SwapQuoteRequestSchema,
  SwapQuoteResultSchema,
  type SwapQuoteRequest,
  type SwapQuoteResult,
} from "./adapters/jupiter/SwapGateway.js";
export {
  JupiterApiSwapGateway,
  type JupiterApiSwapGatewayOptions,
} from "./adapters/jupiter/JupiterApiSwapGateway.js";
export {
  MockScreeningGateway,
  CandidateDetailsSchema,
  ListCandidatesRequestSchema,
  type CandidateDetails,
  type ListCandidatesRequest,
  type MockScreeningGatewayBehaviors,
  type ScreeningGateway,
} from "./adapters/screening/ScreeningGateway.js";
export {
  HttpScreeningGateway,
  type HttpScreeningGatewayOptions,
} from "./adapters/screening/HttpScreeningGateway.js";
export {
  MockTokenIntelGateway,
  type MockTokenIntelGatewayBehaviors,
  SmartMoneySnapshotSchema,
  type SmartMoneySnapshot,
  type TokenIntelGateway,
  TokenRiskSnapshotSchema,
  type TokenRiskSnapshot,
} from "./adapters/analytics/TokenIntelGateway.js";
export {
  HttpTokenIntelGateway,
  type HttpTokenIntelGatewayOptions,
} from "./adapters/analytics/HttpTokenIntelGateway.js";
export {
  MockPriceGateway,
  SolPriceQuoteSchema,
  type MockPriceGatewayBehaviors,
  type PriceGateway,
  type SolPriceQuote,
} from "./adapters/pricing/PriceGateway.js";
export {
  MockWalletGateway,
  WalletBalanceSnapshotSchema,
  type MockWalletGatewayBehaviors,
  type WalletBalanceSnapshot,
  type WalletGateway,
} from "./adapters/wallet/WalletGateway.js";
export {
  MockLlmGateway,
  CandidateRankingInputSchema,
  CandidateRankingResultSchema,
  ManagementExplanationInputSchema,
  ManagementExplanationResultSchema,
  type CandidateRankingInput,
  type CandidateRankingResult,
  type LlmGateway,
  type ManagementExplanationInput,
  type ManagementExplanationResult,
  type MockLlmGatewayBehaviors,
} from "./adapters/llm/LlmGateway.js";
export {
  MockNotifierGateway,
  type MockNotifierGatewayBehaviors,
  NotificationResultSchema,
  type NotificationResult,
  type NotifierGateway,
  SendAlertInputSchema,
  SendMessageInputSchema,
  type SendAlertInput,
  type SendMessageInput,
} from "./adapters/telegram/NotifierGateway.js";
export {
  ActionRepository,
  type ActionRepositoryOptions,
} from "./adapters/storage/ActionRepository.js";
export {
  FileLessonRepository,
  LessonStoreCorruptError,
  LessonStoreFileSchema,
  type LessonRepositoryInterface,
  type LessonRepositoryOptions,
  type LessonStoreFile,
} from "./adapters/storage/LessonRepository.js";
export {
  FilePerformanceRepository,
  type PerformanceRepositoryInterface,
  type PerformanceRepositoryOptions,
  type PerformanceSummary,
} from "./adapters/storage/PerformanceRepository.js";
export {
  JournalRepository,
  type JournalRepositoryOptions,
} from "./adapters/storage/JournalRepository.js";
export {
  StateRepository,
  type StateRepositoryOptions,
} from "./adapters/storage/StateRepository.js";
export { KeyedLock } from "./infra/locks/KeyedLock.js";
export { WalletLock } from "./infra/locks/walletLock.js";
export { PositionLock } from "./infra/locks/positionLock.js";
export {
  ActionQueue,
  type ActionQueueOptions,
  type QueueActionHandler,
  type QueueExecutionResult,
} from "./app/services/ActionQueue.js";
export {
  buildCloseAccountingSummary,
  CloseAccountingSummarySchema,
  resolveOutOfRangeSince,
  type CloseAccountingSummary,
  type ResolveOutOfRangeSinceInput,
} from "./app/services/AccountingService.js";
export {
  createIdempotencyKey,
  createQueuedAction,
  type CreateQueuedActionInput,
} from "./app/services/ActionService.js";
export {
  buildPortfolioState,
  type BuildPortfolioStateInput,
} from "./app/services/PortfolioStateBuilder.js";
export {
  adviseManagementDecision,
  rankShortlistWithAi,
  ManagementDecisionAdvisorySchema,
  RankedShortlistWithAiSchema,
  type AiMode,
  type AdvisorySource,
  type AdviseManagementDecisionInput,
  type ManagementDecisionAdvisory,
  type RankShortlistWithAiInput,
  type RankedShortlistWithAi,
} from "./app/services/AiAdvisoryService.js";
export {
  DefaultLessonPromptService,
  type BuildLessonsPromptInput,
  type LessonPromptService,
} from "./app/services/LessonPromptService.js";
export {
  buildPerformanceRecordFromClose,
  createRecordPositionPerformanceLessonHook,
  type CreateRecordPositionPerformanceLessonHookInput,
} from "./app/services/PerformanceLessonHook.js";
export {
  countRecentNewDeploys,
  type CountRecentNewDeploysInput,
} from "./app/services/RecentDeployCounter.js";
export { FakeClock } from "./app/simulation/FakeClock.js";
export {
  ReplaySimulationFixtureSchema,
  ReplaySimulationStepSchema,
  ReplaySimulationGateway,
  createReplayFailure,
  createReplaySuccess,
  createReplayTimeout,
  type ReplaySimulationFixture,
  type ReplaySimulationStep,
} from "./app/simulation/ReplaySimulationGateway.js";
export {
  SIMULATION_SCENARIO_PACKS,
  createCircuitBreakerScenarioPack,
  createRebalanceScenarioPack,
  createStopLossScenarioPack,
  createTimeoutReconciliationScenarioPack,
  type SimulationScenarioPack,
} from "./app/simulation/scenarioPacks.js";
export {
  processActionQueue,
  type ProcessActionQueueInput,
} from "./app/usecases/processActionQueue.js";
export {
  runDryRunSimulation,
  type DryRunSimulationCycleResult,
  type RunDryRunSimulationInput,
  type RunDryRunSimulationResult,
} from "./app/usecases/runDryRunSimulation.js";
export {
  confirmDeployAction,
  processDeployAction,
  type ConfirmDeployActionInput,
  type ConfirmDeployActionResult,
  type ProcessDeployActionInput,
} from "./app/usecases/processDeployAction.js";
export {
  DeployActionRequestPayloadSchema,
  requestDeploy,
  type DeployActionRequestPayload,
  type RequestDeployInput,
} from "./app/usecases/requestDeploy.js";
export {
  CloseActionRequestPayloadSchema,
  requestClose,
  type CloseActionRequestPayload,
  type RequestCloseInput,
} from "./app/usecases/requestClose.js";
export {
  RebalanceActionRequestPayloadSchema,
  requestRebalance,
  type RebalanceActionRequestPayload,
  type RequestRebalanceInput,
} from "./app/usecases/requestRebalance.js";
export {
  processCloseAction,
  type ProcessCloseActionInput,
} from "./app/usecases/processCloseAction.js";
export {
  processRebalanceAction,
  RebalanceCloseSubmittedPayloadSchema,
  type ProcessRebalanceActionInput,
  type RebalanceCloseSubmittedPayload,
} from "./app/usecases/processRebalanceAction.js";
export {
  finalizeClose,
  PostCloseSwapInputSchema,
  type FinalizeCloseInput,
  type FinalizeCloseResult,
  type LessonHook,
  type LessonHookInput,
  type PostCloseSwapHook,
  type PostCloseSwapInput,
} from "./app/usecases/finalizeClose.js";
export {
  finalizeRebalance,
  RebalanceAbortedPayloadSchema,
  RebalanceActionResultPayloadSchema,
  RebalanceCompletedPayloadSchema,
  RebalanceRedeploySubmittedPayloadSchema,
  type FinalizeRebalanceInput,
  type FinalizeRebalanceResult,
} from "./app/usecases/finalizeRebalance.js";
export {
  reconcilePortfolio,
  type ReconcilePortfolioInput,
  type ReconcilePortfolioResult,
  type ReconciliationRecord,
} from "./app/usecases/reconcilePortfolio.js";
export {
  executeOperatorCommand,
  parseOperatorCommand,
  type ExecuteOperatorCommandInput,
  type OperatorCommand,
  type OperatorCommandExecutionResult,
  type OperatorCommandParseInput,
} from "./app/usecases/operatorCommands.js";
export {
  recordPositionPerformance,
  type RecordPositionPerformanceInput,
  type RecordPositionPerformanceResult,
} from "./app/usecases/recordPositionPerformance.js";
export {
  handleCliOperatorCommand,
  type HandleCliOperatorCommandInput,
} from "./app/usecases/handleCliOperatorCommand.js";
export {
  handleTelegramOperatorCommand,
  type HandleTelegramOperatorCommandInput,
} from "./app/usecases/handleTelegramOperatorCommand.js";
export {
  sendOperatorAlert,
  type SendOperatorAlertInput,
} from "./app/usecases/sendOperatorAlert.js";
export {
  runManagementCycle,
  type ManagementCyclePositionResult,
  type ManagementCycleResultStatus,
  type RunManagementCycleInput,
  type RunManagementCycleResult,
} from "./app/usecases/runManagementCycle.js";
export {
  runReconciliationWorker,
  type ReconciliationWorkerInput,
} from "./app/workers/reconciliationWorker.js";
export {
  runManagementWorker,
  type ManagementWorkerInput,
} from "./app/workers/managementWorker.js";
export {
  AiModeSchema,
  EnvSecretsSchema,
  ResolvedConfigSchema,
  UserConfigSchema,
  type EnvSecrets,
  type ResolvedConfig,
  type UserConfig,
} from "./infra/config/configSchema.js";
export {
  ConfigValidationError,
  loadConfig,
  redactSecretsForLogging,
} from "./infra/config/loadConfig.js";
export { createUlid } from "./infra/id/createUlid.js";
export {
  ensureDataDir,
  resolveMeridianPaths,
  type MeridianPaths,
} from "./infra/config/paths.js";
export { logger } from "./infra/logging/logger.js";
