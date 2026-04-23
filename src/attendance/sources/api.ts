/**
 * HTTP API data source (rc.88, placeholder).
 *
 * The pilot starts with CSV — HR hasn't built the API yet. This class
 * exists so the selector has a concrete implementation to fall through
 * to when `preferredKind === 'api'` is configured but the endpoint isn't
 * reachable. The moment HR ships an API, only the body of
 * `getRoster` / `getBadgeRecords` need to implement real parsing —
 * everything around it is ready.
 *
 * Returns `{ available: false }` from healthCheck() when no endpoint URL
 * is set, so the selector falls back automatically. When an endpoint IS
 * set, it performs a cheap HEAD/GET probe to decide availability.
 */
import type {
  AttendanceDataSource,
  RosterEntry,
  BadgeRecord,
  DateOnly,
  ApiSourceConfig,
} from '../types.js';

export interface ApiSourceDeps {
  // Room for future helpers — e.g., token refresh, retry policy — kept
  // as a separate seam so tests and the selector stay thin.
  fetchFn?: typeof fetch;
}

export class ApiAttendanceSource implements AttendanceDataSource {
  public readonly kind = 'api' as const;

  constructor(
    public readonly moduleId: string,
    private readonly dataType: 'roster' | 'badge',
    private readonly config: ApiSourceConfig,
    private readonly deps: ApiSourceDeps = {},
  ) {}

  async healthCheck(): Promise<{ available: boolean; reason?: string }> {
    if (!this.config.endpointUrl || this.config.endpointUrl.trim() === '') {
      return { available: false, reason: 'API endpoint URL not configured' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await this.fetch(this.config.endpointUrl, {
          method: 'HEAD',
          headers: this.authHeaders(),
          signal: controller.signal,
        });
        if (res.ok || res.status === 405) {
          // 405 Method Not Allowed on HEAD is fine — it means the endpoint
          // exists but doesn't support HEAD. Good enough for liveness.
          return { available: true };
        }
        return { available: false, reason: `HEAD ${this.config.endpointUrl} → ${res.status}` };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { available: false, reason: `API unreachable: ${(err as Error).message}` };
    }
  }

  async getRoster(date: DateOnly): Promise<RosterEntry[]> {
    if (this.dataType !== 'roster') {
      throw new Error(`ApiAttendanceSource configured for ${this.dataType}, cannot serve roster`);
    }
    throw new Error(
      'ApiAttendanceSource.getRoster is not implemented yet. ' +
      'Implement the HTTP call + response parser when HR publishes the API contract. ' +
      `Target URL: ${this.config.endpointUrl} | module=${this.moduleId} date=${date}`,
    );
  }

  async getBadgeRecords(date: DateOnly): Promise<BadgeRecord[]> {
    if (this.dataType !== 'badge') {
      throw new Error(`ApiAttendanceSource configured for ${this.dataType}, cannot serve badge records`);
    }
    throw new Error(
      'ApiAttendanceSource.getBadgeRecords is not implemented yet. ' +
      'Implement the HTTP call + response parser when HR publishes the API contract. ' +
      `Target URL: ${this.config.endpointUrl} | module=${this.moduleId} date=${date}`,
    );
  }

  private fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    return (this.deps.fetchFn ?? fetch)(...args);
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    switch (this.config.authMethod) {
      case 'bearer':
        if (this.config.authValue) h['Authorization'] = `Bearer ${this.config.authValue}`;
        break;
      case 'basic':
        if (this.config.authValue) {
          const encoded = Buffer.from(this.config.authValue).toString('base64');
          h['Authorization'] = `Basic ${encoded}`;
        }
        break;
      case 'header':
        if (this.config.authHeaderName && this.config.authValue) {
          h[this.config.authHeaderName] = this.config.authValue;
        }
        break;
      case 'none':
      default:
        break;
    }
    return h;
  }
}
