import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Application } from '../src/core/app.js';
import type {
  StorageProvider,
  TableInitializer,
  Platform,
} from '../src/core/interfaces.js';

// ── Helpers ──────────────────────────────────────────────────

function createMockStorage(): StorageProvider {
  const tableInits: TableInitializer[] = [];
  return {
    init: vi.fn(),
    getDb: vi.fn(() => ({} as any)),
    registerTables: vi.fn((init: TableInitializer) => tableInits.push(init)),
    initAllTables: vi.fn(() => {
      for (const init of tableInits) init.initTables();
    }),
    close: vi.fn(),
  };
}

function createMockPlatform(name: string, handlePattern?: (chatId: string) => boolean): Platform {
  return {
    name,
    canHandle: handlePattern ?? (() => true),
    notify: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('Application core', () => {
  let app: Application;
  let storage: StorageProvider;

  beforeEach(() => {
    app = new Application();
    storage = createMockStorage();
  });

  // ── Registration ─────────────────────────────────────────

  describe('registration', () => {
    it('registers storage provider', () => {
      app.registerStorage(storage);
      expect(app.storage).toBe(storage);
    });

    it('rejects duplicate storage registration', () => {
      app.registerStorage(storage);
      expect(() => app.registerStorage(createMockStorage())).toThrow('already registered');
    });

    it('registers platforms', () => {
      app.registerStorage(storage);
      const telegram = createMockPlatform('telegram');
      const matrix = createMockPlatform('matrix');
      app.registerPlatform(telegram);
      app.registerPlatform(matrix);
      expect(app.platforms).toHaveLength(2);
      expect(app.platforms[0].name).toBe('telegram');
      expect(app.platforms[1].name).toBe('matrix');
    });

    it('registers subsystems', () => {
      app.registerStorage(storage);
      app.registerSubsystem({ name: 'skills' });
      app.registerSubsystem({ name: 'tools' });
      expect(app.subsystems).toHaveLength(2);
    });

    it('auto-registers table initializer from subsystem', () => {
      app.registerStorage(storage);
      const initFn = vi.fn();
      app.registerSubsystem({
        name: 'sigma',
        tables: { name: 'sigma', initTables: initFn },
      });
      expect(storage.registerTables).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sigma' }),
      );
    });
  });

  // ── Startup lifecycle ────────────────────────────────────

  describe('startup', () => {
    it('throws without storage registered', async () => {
      await expect(app.startup()).rejects.toThrow('no StorageProvider');
    });

    it('calls storage.init() then storage.initAllTables()', async () => {
      app.registerStorage(storage);
      await app.startup();
      expect(storage.init).toHaveBeenCalled();
      expect(storage.initAllTables).toHaveBeenCalled();
    });

    it('executes table initializers in registration order', async () => {
      app.registerStorage(storage);
      const order: string[] = [];
      app.registerSubsystem({
        name: 'first',
        tables: { name: 'first', initTables: () => order.push('first') },
      });
      app.registerSubsystem({
        name: 'second',
        tables: { name: 'second', initTables: () => order.push('second') },
      });
      await app.startup();
      expect(order).toEqual(['first', 'second']);
    });

    it('calls subsystem.init() in registration order', async () => {
      app.registerStorage(storage);
      const order: string[] = [];
      app.registerSubsystem({
        name: 'skills',
        init: () => { order.push('skills'); },
      });
      app.registerSubsystem({
        name: 'tools',
        init: () => { order.push('tools'); },
      });
      await app.startup();
      expect(order).toEqual(['skills', 'tools']);
    });

    it('calls subsystem.setup(app) after all init() calls', async () => {
      app.registerStorage(storage);
      const events: string[] = [];
      app.registerSubsystem({
        name: 'scheduler',
        init: () => { events.push('init:scheduler'); },
        setup: (appRef) => {
          events.push('setup:scheduler');
          expect(appRef).toBe(app);
        },
      });
      app.registerSubsystem({
        name: 'proactive',
        init: () => { events.push('init:proactive'); },
        setup: (appRef) => {
          events.push('setup:proactive');
          expect(appRef).toBe(app);
        },
      });
      await app.startup();
      expect(events).toEqual([
        'init:scheduler',
        'init:proactive',
        'setup:scheduler',
        'setup:proactive',
      ]);
    });

    it('calls platform.start() after subsystem setup', async () => {
      app.registerStorage(storage);
      const events: string[] = [];
      app.registerSubsystem({
        name: 'core',
        setup: () => { events.push('setup:core'); },
      });
      const platform = createMockPlatform('telegram');
      (platform.start as any).mockImplementation(async () => { events.push('start:telegram'); });
      app.registerPlatform(platform);
      await app.startup();
      expect(events).toEqual(['setup:core', 'start:telegram']);
    });

    it('rejects double startup', async () => {
      app.registerStorage(storage);
      await app.startup();
      await expect(app.startup()).rejects.toThrow('already started');
    });

    it('sets started flag', async () => {
      app.registerStorage(storage);
      expect(app.started).toBe(false);
      await app.startup();
      expect(app.started).toBe(true);
    });
  });

  // ── Shutdown lifecycle ───────────────────────────────────

  describe('shutdown', () => {
    it('stops platforms before subsystem shutdown', async () => {
      app.registerStorage(storage);
      const events: string[] = [];
      app.registerSubsystem({
        name: 'scheduler',
        shutdown: () => { events.push('shutdown:scheduler'); },
      });
      const platform = createMockPlatform('telegram');
      (platform.stop as any).mockImplementation(async () => { events.push('stop:telegram'); });
      app.registerPlatform(platform);

      await app.startup();
      await app.shutdown('SIGTERM');
      expect(events).toEqual(['stop:telegram', 'shutdown:scheduler']);
    });

    it('shuts down subsystems in reverse registration order', async () => {
      app.registerStorage(storage);
      const order: string[] = [];
      app.registerSubsystem({
        name: 'first',
        shutdown: () => { order.push('first'); },
      });
      app.registerSubsystem({
        name: 'second',
        shutdown: () => { order.push('second'); },
      });
      await app.startup();
      await app.shutdown();
      expect(order).toEqual(['second', 'first']);
    });

    it('closes storage after subsystems', async () => {
      app.registerStorage(storage);
      const events: string[] = [];
      app.registerSubsystem({
        name: 'core',
        shutdown: () => { events.push('shutdown:core'); },
      });
      (storage.close as any).mockImplementation(() => { events.push('close:storage'); });
      await app.startup();
      await app.shutdown();
      expect(events).toEqual(['shutdown:core', 'close:storage']);
    });

    it('runs cleanup functions', async () => {
      app.registerStorage(storage);
      const cleanupFn = vi.fn();
      app.addCleanup(cleanupFn);
      await app.startup();
      await app.shutdown();
      expect(cleanupFn).toHaveBeenCalled();
    });

    it('is idempotent (double shutdown is safe)', async () => {
      app.registerStorage(storage);
      await app.startup();
      await app.shutdown();
      await app.shutdown(); // should not throw
      expect(storage.close).toHaveBeenCalledTimes(1);
    });
  });

  // ── Notification (Jarvis outbound) ───────────────────────

  describe('notify', () => {
    it('routes to platform where canHandle returns true', async () => {
      app.registerStorage(storage);
      const telegram = createMockPlatform('telegram', (id) => !id.startsWith('!'));
      const matrix = createMockPlatform('matrix', (id) => id.startsWith('!'));
      app.registerPlatform(telegram);
      app.registerPlatform(matrix);
      await app.startup();

      await app.notify('12345', 'Hello from scheduler');
      expect(telegram.notify).toHaveBeenCalledWith('12345', 'Hello from scheduler');
      expect(matrix.notify).not.toHaveBeenCalled();
    });

    it('routes Matrix chat IDs to Matrix platform', async () => {
      app.registerStorage(storage);
      const telegram = createMockPlatform('telegram', (id) => !id.startsWith('!'));
      const matrix = createMockPlatform('matrix', (id) => id.startsWith('!'));
      app.registerPlatform(telegram);
      app.registerPlatform(matrix);
      await app.startup();

      await app.notify('!room:matrix.org', 'Digest ready');
      expect(matrix.notify).toHaveBeenCalledWith('!room:matrix.org', 'Digest ready');
      expect(telegram.notify).not.toHaveBeenCalled();
    });

    it('returns false when no platform can handle the chatId', async () => {
      app.registerStorage(storage);
      const telegram = createMockPlatform('telegram', () => false);
      app.registerPlatform(telegram);
      await app.startup();

      const result = await app.notify('unknown-chat', 'Hello');
      expect(result).toBe(false);
      expect(telegram.notify).not.toHaveBeenCalled();
    });

    it('returns true on successful delivery', async () => {
      app.registerStorage(storage);
      app.registerPlatform(createMockPlatform('telegram'));
      await app.startup();

      const result = await app.notify('12345', 'Task complete');
      expect(result).toBe(true);
    });

    it('returns false and logs warning on platform error', async () => {
      app.registerStorage(storage);
      const failingPlatform = createMockPlatform('telegram');
      (failingPlatform.notify as any).mockRejectedValue(new Error('Network error'));
      app.registerPlatform(failingPlatform);
      await app.startup();

      const result = await app.notify('12345', 'Hello');
      expect(result).toBe(false);
    });

    it('setup phase gives subsystem access to app.notify', async () => {
      app.registerStorage(storage);
      const platform = createMockPlatform('telegram');
      app.registerPlatform(platform);

      let capturedNotify: typeof app.notify | null = null;
      app.registerSubsystem({
        name: 'scheduler',
        setup: (appRef) => {
          capturedNotify = appRef.notify.bind(appRef);
        },
      });

      await app.startup();
      expect(capturedNotify).not.toBeNull();

      // Simulate autonomous notification from scheduler
      await capturedNotify!('12345', 'Scheduled task complete');
      expect(platform.notify).toHaveBeenCalledWith('12345', 'Scheduled task complete');
    });
  });

  // ── Provider slots ───────────────────────────────────────

  describe('provider slots', () => {
    it('starts with null providers', () => {
      expect(app.router).toBeNull();
      expect(app.memory).toBeNull();
      expect(app.tools).toBeNull();
      expect(app.packs).toBeNull();
    });

    it('allows setting provider slots', () => {
      const mockRouter = {} as any;
      app.router = mockRouter;
      expect(app.router).toBe(mockRouter);
    });

    it('provider slots are accessible in subsystem setup phase', async () => {
      app.registerStorage(storage);

      const mockTools = { list: vi.fn(() => []) } as any;
      const mockMemory = { buildContext: vi.fn() } as any;
      const mockPacks = { getAggregatedCapabilities: vi.fn(() => '') } as any;

      app.registerSubsystem({
        name: 'providers',
        init: () => {
          app.tools = mockTools;
          app.memory = mockMemory;
          app.packs = mockPacks;
        },
      });

      let toolsAvailable = false;
      let memoryAvailable = false;
      let packsAvailable = false;

      app.registerSubsystem({
        name: 'consumer',
        setup: (appRef) => {
          toolsAvailable = appRef.tools !== null;
          memoryAvailable = appRef.memory !== null;
          packsAvailable = appRef.packs !== null;
        },
      });

      await app.startup();
      expect(toolsAvailable).toBe(true);
      expect(memoryAvailable).toBe(true);
      expect(packsAvailable).toBe(true);
    });
  });
});
