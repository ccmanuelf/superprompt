/**
 * Core subsystem interfaces — the single source of truth for all clauded contracts.
 *
 * Every subsystem boundary in the application is defined here. Implementations
 * live in their respective modules; this file defines what they must provide.
 *
 * Design principles:
 * - Registry-based composition (not dependency injection)
 * - Autonomous-first: platforms expose notify() for outbound messaging
 * - Active subsystems receive the Application via setup() for Jarvis-like behavior
 * - All existing module exports preserved for backward compatibility
 */

import type Database from 'better-sqlite3';
import type { Tool } from 'ollama';

// Re-export the existing AI provider contract as the canonical reference
export type { AIProvider, SendMessageParams, AIResponse, GeneratedFile } from '../providers/types.js';

// ── Storage ─────────────────────────────────────────────────

/**
 * A subsystem that needs database tables registers a TableInitializer.
 * This replaces the pattern where db.ts imported 16+ domain modules directly.
 */
export interface TableInitializer {
  /** Unique name for logging and ordering */
  name: string;
  /** Create tables, indexes, triggers. Called once after the database is open. */
  initTables(): void;
}

/**
 * Database lifecycle and table registration.
 * Wraps the existing better-sqlite3 singleton with a registration protocol.
 */
export interface StorageProvider {
  /** Open the database, enable WAL mode, load extensions, create core tables */
  init(): void;
  /** Get the raw database handle — backward compat with getDatabase() */
  getDb(): Database.Database;
  /** Register a subsystem's table initializer (call before init or initAllTables) */
  registerTables(initializer: TableInitializer): void;
  /** Execute all registered table initializers in registration order */
  initAllTables(): void;
  /** Close the database connection */
  close(): void;
}

// ── Memory ──────────────────────────────────────────────────

/**
 * Memory retrieval, storage, and maintenance.
 * Dual-sector: semantic (facts) + episodic (conversation summaries).
 */
export interface MemoryProvider {
  /** Build a context string from relevant memories for the AI system prompt */
  buildContext(chatId: string, userMessage: string, maxTokens?: number): Promise<string>;
  /** Store a conversation turn (user + assistant) with semantic extraction */
  saveConversationTurn(chatId: string, userMsg: string, assistantMsg: string): Promise<void>;
  /** Run salience decay, episode compression, and cleanup of expired memories */
  runDecaySweep(): Promise<void>;
}

// ── Tools ───────────────────────────────────────────────────

// ── Tool Policy (SA4) ───────────────────────────────────────

/**
 * Capabilities a tool requires. Used by the policy engine to evaluate
 * whether execution should be allowed in the current context.
 */
export type ToolScope =
  | 'network'           // makes HTTP requests to external services
  | 'filesystem:read'   // reads files from disk
  | 'filesystem:write'  // writes files to disk
  | 'command'           // executes shell commands
  | 'database:read'     // reads from database
  | 'database:write'    // modifies database
  | 'browser'           // uses headless browser (Chromium)
  | 'stateless';        // no I/O, pure computation

/**
 * Risk metadata for a tool. Drives the policy engine's enforcement decisions.
 */
export interface ToolPolicy {
  /** Risk classification */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** What capabilities this tool needs */
  scopes: ToolScope[];
  /** Whether user must confirm before execution (checked against trust memory) */
  requiresConfirmation: boolean;
  /** Override default execution timeout (seconds) */
  maxExecutionTime?: number;
}

/**
 * Result of the policy engine's evaluation before tool execution.
 */
export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
}

/**
 * Tool entry — definition + execution handler + risk metadata.
 * Matches the existing ToolEntry in forge/tool-registry.ts.
 */
export interface ToolEntry {
  definition: Tool;
  execute: (args: Record<string, unknown>, chatId: string) => Promise<Record<string, unknown>>;
  source: 'builtin' | 'user';
  /**
   * Which process executes this tool.
   * - 'core': DB-dependent tools — execute in Process 1 (default)
   * - 'tools': DB-free compute/network tools — execute in Process 2
   * - 'parsers': File parsing tools — execute in Process 3 (tightest sandbox)
   */
  process?: 'core' | 'tools' | 'parsers';
  /** Risk metadata — drives policy engine enforcement (SA4) */
  policy?: ToolPolicy;
  /** Which pack owns this tool — used by pack tuner for weight tracking */
  packName?: string;
}

/**
 * Tool registration, discovery, and execution.
 * Backs both builtin tools and user-generated tools (via Worker sandbox).
 */
export interface ToolProvider {
  /** Register a tool in the in-memory registry */
  register(entry: ToolEntry): void;
  /** Remove a tool from the registry */
  unregister(name: string): void;
  /** Get a tool entry by name */
  get(name: string): ToolEntry | undefined;
  /** Execute a tool by name, returning result or { error: ... } */
  execute(name: string, args: Record<string, unknown>, chatId: string): Promise<Record<string, unknown>>;
  /** Get tool definitions for the AI model, optionally filtered by allowed list */
  getDefinitions(allowedTools?: string[]): Tool[];
  /** List all registered tools with metadata */
  list(): Array<{ name: string; description: string; source: string }>;
  /** Load user tools from database and register them */
  loadUserTools(envVars?: Record<string, string>): number;
}

// ── Packs ───────────────────────────────────────────────────

/**
 * Domain pack intent match result.
 */
export interface IntentMatch {
  score: number;
  tools: string[];
  webApps: string[];
}

/**
 * Domain pack loading, capability aggregation, and intent scoring.
 * Packs extend clauded with department-specific tools, skills, and templates.
 */
export interface PackProvider {
  /** Load all packs from the packs/ directory */
  loadAll(): unknown[];
  /** Get a loaded pack by name */
  getByName(name: string): unknown | undefined;
  /** Get aggregated capability descriptions for the AI system prompt */
  getAggregatedCapabilities(): string;
  /** Score a user message against all loaded pack intent patterns */
  scoreIntent(message: string): IntentMatch;
}

// ── Platform ────────────────────────────────────────────────

/**
 * A messaging platform adapter (Telegram, Matrix, Web).
 *
 * Platforms handle both inbound (user → AI) and outbound (AI → user) messaging.
 * The outbound channel (canHandle + notify) is the foundation for autonomous
 * behavior: scheduler, proactive messaging, and future features like
 * S17 order alerts and S18 shortage warnings all push through notify().
 */
export interface Platform {
  /** Platform identifier */
  name: string;
  /**
   * Can this platform deliver messages to this chatId?
   * Used by app.notify() to route outbound messages to the correct platform.
   * Example: Matrix room IDs start with '!', Telegram chat IDs are numeric.
   */
  canHandle(chatId: string): boolean;
  /**
   * Push a notification to a user — the autonomous/Jarvis outbound channel.
   * Called by the Application when any subsystem invokes app.notify().
   */
  notify(chatId: string, text: string): Promise<void>;
  /** Start listening for inbound messages */
  start(): Promise<void>;
  /** Stop the platform gracefully */
  stop(): Promise<void>;
}

// ── Subsystem ───────────────────────────────────────────────

// Forward declaration — Application is defined in app.ts
// Using import type to avoid circular runtime dependency
import type { Application } from './app.js';

/**
 * A registrable subsystem with lifecycle hooks.
 *
 * Lifecycle order during startup:
 * 1. storage.init() + storage.initAllTables()
 * 2. subsystem.init() — in registration order (DB is ready, tables exist)
 * 3. subsystem.setup(app) — all subsystems initialized, full app context available
 * 4. platform.start() — messaging channels open
 *
 * The setup() phase is critical for autonomous subsystems (scheduler, proactive):
 * they receive the Application reference to call app.notify() and app.router
 * on their own schedule, without user initiation.
 */
export interface Subsystem {
  /** Unique subsystem name for logging */
  name: string;
  /** Optional table initializer — registered with StorageProvider automatically */
  tables?: TableInitializer;
  /** Called during startup, after DB tables are created. For one-time initialization. */
  init?(): void | Promise<void>;
  /**
   * Called after ALL subsystems are initialized.
   * Active subsystems receive the Application reference for autonomous behavior.
   * Use this to access app.notify(), app.router, app.tools, etc.
   */
  setup?(app: Application): void | Promise<void>;
  /** Called during shutdown, in reverse registration order */
  shutdown?(): void | Promise<void>;
}
