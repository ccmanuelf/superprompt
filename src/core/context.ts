/**
 * PlatformContext — the facade that platforms use to access subsystems.
 *
 * Replaces 18+ direct module imports in platform files with a single typed object.
 * Platforms receive this context at creation time instead of importing modules directly.
 *
 * Design: types derived FROM source modules via typeof — when source signatures
 * change, this file and platform files get compile errors automatically.
 * Dynamic imports for domain-specific CSV handlers remain as dynamic imports.
 */

import type { ProviderRouter } from '../providers/router.js';

// Import the actual functions to derive their types
import type { buildMemoryContext, saveConversationTurn } from '../memory.js';
import type {
  getMemoriesByChatId,
  listSkills, getSkillByName, setActiveSkill, clearActiveSkill, getActiveSkill,
  createSkill, deleteSkill, lockSkill, unlockSkill, insertSkillRevision, updateSkill,
  listUserTools, getUserToolByName, createUserTool, updateUserTool, deleteUserTool,
  enableUserTool, disableUserTool, lockUserTool, unlockUserTool, insertToolRevision,
  createTask, getTasksByChat, getTask, pauseTask, resumeTask, deleteTask,
} from '../db.js';
import type { transcribeAudio, synthesizeSpeech, voiceCapabilities } from '../voice.js';
import type { computeNextRun, validateCron } from '../scheduler.js';
import type { parseFile } from '../files.js';
import type { isDocGenResponse, parseDocGenResponse, generateDocument, stripDocGenBlock } from '../docgen.js';
import type { parseSkillMarkdown } from '../forge/skill-parser.js';
import type { fixSkill } from '../forge/skill-fixer.js';
import type { parseToolMarkdown } from '../forge/tool-parser.js';
import type { scanToolCode } from '../forge/safety-scanner.js';
import type { generateToolCode } from '../forge/tool-generator.js';
import type { fixTool } from '../forge/tool-fixer.js';
import type { exportSkillToMarkdown, exportToolToMarkdown } from '../forge/exporter.js';
import type { listRegisteredTools, loadUserTools } from '../forge/tool-registry.js';
import type { shouldOrchestrate, orchestrateTask } from '../orchestrator.js';
import type {
  buildDigest, getDigestPreference, setDigestPreference, triggerBotTasksNow,
} from '../proactive.js';
import type {
  createCard, moveCard, assignCard, updateCard, listCards, getCardByPrefix, deleteCard,
  formatBoard, formatCard, isKanbanAction, parseKanbanAction, executeKanbanAction, stripKanbanBlock,
  parseDateHint,
} from '../kanban.js';
import type { getCitations, exportCitations, clearCitations, formatCitationList, addCitation } from '../citations.js';
import type { checkResponseQuality, logQualityCheck } from '../self-monitor.js';
import type { searchPapers } from '../providers/tools/research.js';

// Learning module has many exports — import the module type itself
import type * as LearningModule from '../learning/index.js';

// ── PlatformContext Type ────────────────────────────────────

export interface PlatformContext {
  router: ProviderRouter;

  memory: {
    buildContext: typeof buildMemoryContext;
    saveConversationTurn: typeof saveConversationTurn;
    getMemoriesByChatId: typeof getMemoriesByChatId;
  };

  skills: {
    list: typeof listSkills;
    getByName: typeof getSkillByName;
    setActive: typeof setActiveSkill;
    clearActive: typeof clearActiveSkill;
    getActive: typeof getActiveSkill;
    create: typeof createSkill;
    delete: typeof deleteSkill;
    lock: typeof lockSkill;
    unlock: typeof unlockSkill;
    insertRevision: typeof insertSkillRevision;
    update: typeof updateSkill;
  };

  tools: {
    listRegistered: typeof listRegisteredTools;
    loadUserTools: typeof loadUserTools;
    listUserTools: typeof listUserTools;
    getByName: typeof getUserToolByName;
    create: typeof createUserTool;
    update: typeof updateUserTool;
    delete: typeof deleteUserTool;
    enable: typeof enableUserTool;
    disable: typeof disableUserTool;
    lock: typeof lockUserTool;
    unlock: typeof unlockUserTool;
    insertRevision: typeof insertToolRevision;
  };

  forge: {
    parseSkillMarkdown: typeof parseSkillMarkdown;
    fixSkill: typeof fixSkill;
    parseToolMarkdown: typeof parseToolMarkdown;
    scanToolCode: typeof scanToolCode;
    generateToolCode: typeof generateToolCode;
    fixTool: typeof fixTool;
    exportSkillToMarkdown: typeof exportSkillToMarkdown;
    exportToolToMarkdown: typeof exportToolToMarkdown;
  };

  tasks: {
    create: typeof createTask;
    getByChat: typeof getTasksByChat;
    get: typeof getTask;
    pause: typeof pauseTask;
    resume: typeof resumeTask;
    delete: typeof deleteTask;
    computeNextRun: typeof computeNextRun;
    validateCron: typeof validateCron;
  };

  kanban: {
    createCard: typeof createCard;
    moveCard: typeof moveCard;
    assignCard: typeof assignCard;
    updateCard: typeof updateCard;
    listCards: typeof listCards;
    getCardByPrefix: typeof getCardByPrefix;
    deleteCard: typeof deleteCard;
    formatBoard: typeof formatBoard;
    formatCard: typeof formatCard;
    isKanbanAction: typeof isKanbanAction;
    parseKanbanAction: typeof parseKanbanAction;
    executeKanbanAction: typeof executeKanbanAction;
    stripKanbanBlock: typeof stripKanbanBlock;
    parseDateHint: typeof parseDateHint;
  };

  voice: {
    transcribe: typeof transcribeAudio;
    synthesize: typeof synthesizeSpeech;
    capabilities: typeof voiceCapabilities;
  };

  files: {
    parse: typeof parseFile;
  };

  docgen: {
    isResponse: typeof isDocGenResponse;
    parseResponse: typeof parseDocGenResponse;
    generate: typeof generateDocument;
    stripBlock: typeof stripDocGenBlock;
  };

  orchestrator: {
    shouldOrchestrate: typeof shouldOrchestrate;
    orchestrateTask: typeof orchestrateTask;
  };

  proactive: {
    buildDigest: typeof buildDigest;
    getPreference: typeof getDigestPreference;
    setPreference: typeof setDigestPreference;
    triggerBotTasksNow: typeof triggerBotTasksNow;
  };

  citations: {
    get: typeof getCitations;
    export: typeof exportCitations;
    clear: typeof clearCitations;
    formatList: typeof formatCitationList;
    add: typeof addCitation;
  };

  selfMonitor: {
    checkQuality: typeof checkResponseQuality;
    logCheck: typeof logQualityCheck;
  };

  research: {
    searchPapers: typeof searchPapers;
  };

  learning: {
    getActivePlansByChat: typeof LearningModule.getActivePlansByChat;
    getPlansByChat: typeof LearningModule.getPlansByChat;
    getPlanBySubject: typeof LearningModule.getPlanBySubject;
    getTopicsByPlan: typeof LearningModule.getTopicsByPlan;
    getPlan: typeof LearningModule.getPlan;
    updatePlan: typeof LearningModule.updatePlan;
    deletePlan: typeof LearningModule.deletePlan;
    getDailyTime: typeof LearningModule.getDailyTime;
    getWeeklyTime: typeof LearningModule.getWeeklyTime;
    getMostOverduePlan: typeof LearningModule.getMostOverduePlan;
    getLeastRecentPlan: typeof LearningModule.getLeastRecentPlan;
    buildPlanPrompt: typeof LearningModule.buildPlanPrompt;
    parsePlanResponse: typeof LearningModule.parsePlanResponse;
    createPlanFromTopics: typeof LearningModule.createPlanFromTopics;
    formatPlan: typeof LearningModule.formatPlan;
    formatPlanList: typeof LearningModule.formatPlanList;
    extractSubject: typeof LearningModule.extractSubject;
    needsExpansion: typeof LearningModule.needsExpansion;
    buildExpandPrompt: typeof LearningModule.buildExpandPrompt;
    addExpansionTopics: typeof LearningModule.addExpansionTopics;
    buildAddTopicPrompt: typeof LearningModule.buildAddTopicPrompt;
    parseTopicPlacement: typeof LearningModule.parseTopicPlacement;
    createTopic: typeof LearningModule.createTopic;
    moveTopicBefore: typeof LearningModule.moveTopicBefore;
    requestTopicRemoval: typeof LearningModule.requestTopicRemoval;
    completeTopicRemoval: typeof LearningModule.completeTopicRemoval;
    rejectTopicRemoval: typeof LearningModule.rejectTopicRemoval;
    buildAssessmentPrompt: typeof LearningModule.buildAssessmentPrompt;
    getTopicByTitle: typeof LearningModule.getTopicByTitle;
    listPersonas: typeof LearningModule.listPersonas;
    getPersona: typeof LearningModule.getPersona;
    selectPersonaForSubject: typeof LearningModule.selectPersonaForSubject;
    startSession: typeof LearningModule.startSession;
    isSessionActive: typeof LearningModule.isSessionActive;
    getActiveSession: typeof LearningModule.getActiveSession;
    touchSession: typeof LearningModule.touchSession;
    processSessionResponse: typeof LearningModule.processSessionResponse;
    stripMarkers: typeof LearningModule.stripMarkers;
    endSession: typeof LearningModule.endSession;
    dismissSession: typeof LearningModule.dismissSession;
    getSessionSystemPrompt: typeof LearningModule.getSessionSystemPrompt;
    formatSessionSummary: typeof LearningModule.formatSessionSummary;
    initSessionCleanup: typeof LearningModule.initSessionCleanup;
  };
}

// ── Builder ─────────────────────────────────────────────────

/**
 * Build a PlatformContext from existing module exports.
 * Called once during application startup, before platform creation.
 */
export async function buildPlatformContext(router: ProviderRouter): Promise<PlatformContext> {
  const [
    memoryMod, dbMod, voiceMod, schedulerMod, filesMod, docgenMod,
    skillParserMod, skillFixerMod, toolParserMod, scannerMod,
    toolRegistryMod, toolGenMod, toolFixerMod, exporterMod,
    proactiveMod, orchestratorMod, kanbanMod, citationsMod,
    selfMonitorMod, researchMod, learningMod,
  ] = await Promise.all([
    import('../memory.js'),
    import('../db.js'),
    import('../voice.js'),
    import('../scheduler.js'),
    import('../files.js'),
    import('../docgen.js'),
    import('../forge/skill-parser.js'),
    import('../forge/skill-fixer.js'),
    import('../forge/tool-parser.js'),
    import('../forge/safety-scanner.js'),
    import('../forge/tool-registry.js'),
    import('../forge/tool-generator.js'),
    import('../forge/tool-fixer.js'),
    import('../forge/exporter.js'),
    import('../proactive.js'),
    import('../orchestrator.js'),
    import('../kanban.js'),
    import('../citations.js'),
    import('../self-monitor.js'),
    import('../providers/tools/research.js'),
    import('../learning/index.js'),
  ]);

  return {
    router,
    memory: {
      buildContext: memoryMod.buildMemoryContext,
      saveConversationTurn: memoryMod.saveConversationTurn,
      getMemoriesByChatId: dbMod.getMemoriesByChatId,
    },
    skills: {
      list: dbMod.listSkills,
      getByName: dbMod.getSkillByName,
      setActive: dbMod.setActiveSkill,
      clearActive: dbMod.clearActiveSkill,
      getActive: dbMod.getActiveSkill,
      create: dbMod.createSkill,
      delete: dbMod.deleteSkill,
      lock: dbMod.lockSkill,
      unlock: dbMod.unlockSkill,
      insertRevision: dbMod.insertSkillRevision,
      update: dbMod.updateSkill,
    },
    tools: {
      listRegistered: toolRegistryMod.listRegisteredTools,
      loadUserTools: toolRegistryMod.loadUserTools,
      listUserTools: dbMod.listUserTools,
      getByName: dbMod.getUserToolByName,
      create: dbMod.createUserTool,
      update: dbMod.updateUserTool,
      delete: dbMod.deleteUserTool,
      enable: dbMod.enableUserTool,
      disable: dbMod.disableUserTool,
      lock: dbMod.lockUserTool,
      unlock: dbMod.unlockUserTool,
      insertRevision: dbMod.insertToolRevision,
    },
    forge: {
      parseSkillMarkdown: skillParserMod.parseSkillMarkdown,
      fixSkill: skillFixerMod.fixSkill,
      parseToolMarkdown: toolParserMod.parseToolMarkdown,
      scanToolCode: scannerMod.scanToolCode,
      generateToolCode: toolGenMod.generateToolCode,
      fixTool: toolFixerMod.fixTool,
      exportSkillToMarkdown: exporterMod.exportSkillToMarkdown,
      exportToolToMarkdown: exporterMod.exportToolToMarkdown,
    },
    tasks: {
      create: dbMod.createTask,
      getByChat: dbMod.getTasksByChat,
      get: dbMod.getTask,
      pause: dbMod.pauseTask,
      resume: dbMod.resumeTask,
      delete: dbMod.deleteTask,
      computeNextRun: schedulerMod.computeNextRun,
      validateCron: schedulerMod.validateCron,
    },
    kanban: {
      createCard: kanbanMod.createCard,
      moveCard: kanbanMod.moveCard,
      assignCard: kanbanMod.assignCard,
      updateCard: kanbanMod.updateCard,
      listCards: kanbanMod.listCards,
      getCardByPrefix: kanbanMod.getCardByPrefix,
      deleteCard: kanbanMod.deleteCard,
      formatBoard: kanbanMod.formatBoard,
      formatCard: kanbanMod.formatCard,
      isKanbanAction: kanbanMod.isKanbanAction,
      parseKanbanAction: kanbanMod.parseKanbanAction,
      executeKanbanAction: kanbanMod.executeKanbanAction,
      stripKanbanBlock: kanbanMod.stripKanbanBlock,
      parseDateHint: kanbanMod.parseDateHint,
    },
    voice: {
      transcribe: voiceMod.transcribeAudio,
      synthesize: voiceMod.synthesizeSpeech,
      capabilities: voiceMod.voiceCapabilities,
    },
    files: {
      parse: filesMod.parseFile,
    },
    docgen: {
      isResponse: docgenMod.isDocGenResponse,
      parseResponse: docgenMod.parseDocGenResponse,
      generate: docgenMod.generateDocument,
      stripBlock: docgenMod.stripDocGenBlock,
    },
    orchestrator: {
      shouldOrchestrate: orchestratorMod.shouldOrchestrate,
      orchestrateTask: orchestratorMod.orchestrateTask,
    },
    proactive: {
      buildDigest: proactiveMod.buildDigest,
      getPreference: proactiveMod.getDigestPreference,
      setPreference: proactiveMod.setDigestPreference,
      triggerBotTasksNow: proactiveMod.triggerBotTasksNow,
    },
    citations: {
      get: citationsMod.getCitations,
      export: citationsMod.exportCitations,
      clear: citationsMod.clearCitations,
      formatList: citationsMod.formatCitationList,
      add: citationsMod.addCitation,
    },
    selfMonitor: {
      checkQuality: selfMonitorMod.checkResponseQuality,
      logCheck: selfMonitorMod.logQualityCheck,
    },
    research: {
      searchPapers: researchMod.searchPapers,
    },
    learning: {
      getActivePlansByChat: learningMod.getActivePlansByChat,
      getPlansByChat: learningMod.getPlansByChat,
      getPlanBySubject: learningMod.getPlanBySubject,
      getTopicsByPlan: learningMod.getTopicsByPlan,
      getPlan: learningMod.getPlan,
      updatePlan: learningMod.updatePlan,
      deletePlan: learningMod.deletePlan,
      getDailyTime: learningMod.getDailyTime,
      getWeeklyTime: learningMod.getWeeklyTime,
      getMostOverduePlan: learningMod.getMostOverduePlan,
      getLeastRecentPlan: learningMod.getLeastRecentPlan,
      buildPlanPrompt: learningMod.buildPlanPrompt,
      parsePlanResponse: learningMod.parsePlanResponse,
      createPlanFromTopics: learningMod.createPlanFromTopics,
      formatPlan: learningMod.formatPlan,
      formatPlanList: learningMod.formatPlanList,
      extractSubject: learningMod.extractSubject,
      needsExpansion: learningMod.needsExpansion,
      buildExpandPrompt: learningMod.buildExpandPrompt,
      addExpansionTopics: learningMod.addExpansionTopics,
      buildAddTopicPrompt: learningMod.buildAddTopicPrompt,
      parseTopicPlacement: learningMod.parseTopicPlacement,
      createTopic: learningMod.createTopic,
      moveTopicBefore: learningMod.moveTopicBefore,
      requestTopicRemoval: learningMod.requestTopicRemoval,
      completeTopicRemoval: learningMod.completeTopicRemoval,
      rejectTopicRemoval: learningMod.rejectTopicRemoval,
      buildAssessmentPrompt: learningMod.buildAssessmentPrompt,
      getTopicByTitle: learningMod.getTopicByTitle,
      listPersonas: learningMod.listPersonas,
      getPersona: learningMod.getPersona,
      selectPersonaForSubject: learningMod.selectPersonaForSubject,
      startSession: learningMod.startSession,
      isSessionActive: learningMod.isSessionActive,
      getActiveSession: learningMod.getActiveSession,
      touchSession: learningMod.touchSession,
      processSessionResponse: learningMod.processSessionResponse,
      stripMarkers: learningMod.stripMarkers,
      endSession: learningMod.endSession,
      dismissSession: learningMod.dismissSession,
      getSessionSystemPrompt: learningMod.getSessionSystemPrompt,
      formatSessionSummary: learningMod.formatSessionSummary,
      initSessionCleanup: learningMod.initSessionCleanup,
    },
  };
}
