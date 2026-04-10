import type { Tool } from 'ollama';
import {
  createCard,
  moveCard,
  assignCard,
  updateCard,
  listCards,
  getCardByPrefix,
  getBoardSummary,
  parseDateHint,
  type CardStatus,
  type CardAssignee,
} from '../../kanban.js';
import { logger } from '../../logger.js';

/**
 * Kanban board management tool for Ollama.
 *
 * The AI calls this to create, move, assign, and list cards.
 * When the AI detects an opportunity or task in conversation,
 * it should proactively create a card.
 */

export const kanbanManageDefinition: Tool = {
  type: 'function',
  function: {
    name: 'kanban_manage',
    description: `Manage the shared Kanban board. Use this tool to:
- CREATE a card when you identify a task, idea, issue, or opportunity in conversation
- LIST cards to show the user what's on the board
- MOVE a card to a different status (backlog, in_progress, review, done, deferred, cancelled)
- ASSIGN a card to change ownership
- UPDATE a card's priority, due_date, or scheduled_for
- SUMMARY to show board overview

ASSIGNMENT RULES (follow strictly):
- DEFAULT assignee is always "noted" — capture for visibility, do NOT assign ownership
- Use "bot" ONLY when user explicitly says: "take care of X", "you handle X", "let the bot do X"
- Use "me" ONLY when user explicitly says: "I will do X", "I'll handle this"
- Use "collaborative" ONLY when user explicitly says: "let's work on this together"
- Keep "noted" for everything else — brainstorming, ideas, discussions, reviews
- When in doubt, use "noted" — NEVER assign ownership unless explicitly requested

Be PROACTIVE about capturing items. Be CONSERVATIVE about assigning them.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: create, list, move, assign, update, summary',
          enum: ['create', 'list', 'move', 'assign', 'update', 'summary'],
        },
        title: {
          type: 'string',
          description: 'Card title (for create action)',
        },
        description: {
          type: 'string',
          description: 'Card description (for create action)',
        },
        cardId: {
          type: 'string',
          description: 'Card ID or prefix (for move/assign actions)',
        },
        status: {
          type: 'string',
          description: 'New status (for move action): backlog, in_progress, review, done, deferred, cancelled',
        },
        assignee: {
          type: 'string',
          description: 'Assignee (for create/assign): me, bot, collaborative, noted',
        },
        priority: {
          type: 'number',
          description: 'Priority 1-5 (1=critical, 3=medium, 5=minimal). Default: 3',
        },
        labels: {
          type: 'string',
          description: 'Comma-separated labels (for create action)',
        },
        due_date: {
          type: 'string',
          description: 'Deadline: ISO date (2026-03-25) or natural language. Set from conversation: "by Friday", "due next week".',
        },
        scheduled_for: {
          type: 'string',
          description: 'When bot should START: "tonight", "tomorrow morning", "now", or ISO datetime. Priority 1-2 always immediate; 3-5 default to nightly window.',
        },
      },
      required: ['action'],
    },
  },
};

export async function kanbanManage(
  args: {
    action: string;
    title?: string;
    description?: string;
    cardId?: string;
    status?: string;
    assignee?: string;
    priority?: number;
    labels?: string;
    due_date?: string;
    scheduled_for?: string;
  },
  chatId: string,
): Promise<Record<string, unknown>> {
  switch (args.action) {
    case 'create': {
      if (!args.title) return { error: 'Title is required for create action.' };

      const labels = args.labels?.split(',').map((l) => l.trim()).filter(Boolean);
      const dueDate = args.due_date ? parseDateHint(args.due_date) : undefined;
      const scheduledFor = args.scheduled_for ? parseDateHint(args.scheduled_for) : undefined;

      const card = await createCard(chatId, args.title, {
        description: args.description,
        assignee: (args.assignee as CardAssignee) || 'noted',
        priority: args.priority || 3,
        labels,
        dueDate: dueDate ?? undefined,
        scheduledFor: scheduledFor ?? undefined,
        source: 'bot',
      });

      logger.info({ cardId: card.id, chatId, title: card.title }, 'AI created kanban card');
      let msg = `📋 Card created: "${card.title}" [${card.assignee}] — ID: ${card.id.slice(0, 8)}`;
      if (card.due_date) msg += ` | Due: ${new Date(card.due_date).toLocaleDateString()}`;
      if (card.scheduled_for) msg += ` | Start: ${new Date(card.scheduled_for).toLocaleString()}`;
      return { success: true, cardId: card.id, message: msg };
    }

    case 'list': {
      const status = args.status as CardStatus | undefined;
      const cards = await listCards(chatId, status);

      if (cards.length === 0) {
        return { message: status ? `No cards with status "${status}".` : 'Board is empty.' };
      }

      const formatted = cards.map((c) => ({
        id: c.id.slice(0, 8),
        title: c.title,
        status: c.status,
        assignee: c.assignee,
        priority: c.priority,
      }));

      return { cards: formatted, count: cards.length };
    }

    case 'move': {
      if (!args.cardId) return { error: 'cardId is required for move action.' };
      if (!args.status) return { error: 'status is required for move action.' };

      const card = await getCardByPrefix(chatId, args.cardId);
      if (!card) return { error: `Card "${args.cardId}" not found.` };

      const updated = await moveCard(card.id, args.status as CardStatus);
      if (!updated) return { error: `Invalid status: ${args.status}` };

      return {
        success: true,
        message: `Moved "${updated.title}" → ${updated.status}`,
      };
    }

    case 'assign': {
      if (!args.cardId) return { error: 'cardId is required for assign action.' };
      if (!args.assignee) return { error: 'assignee is required for assign action.' };

      const card = await getCardByPrefix(chatId, args.cardId);
      if (!card) return { error: `Card "${args.cardId}" not found.` };

      const updated = await assignCard(card.id, args.assignee as CardAssignee);
      if (!updated) return { error: `Invalid assignee: ${args.assignee}` };

      return {
        success: true,
        message: `Assigned "${updated.title}" → ${updated.assignee}`,
      };
    }

    case 'update': {
      if (!args.cardId) return { error: 'cardId is required for update action.' };

      const card = await getCardByPrefix(chatId, args.cardId);
      if (!card) return { error: `Card "${args.cardId}" not found.` };

      const updates: Record<string, unknown> = {};
      if (args.priority !== undefined) updates.priority = args.priority;
      if (args.due_date) updates.due_date = parseDateHint(args.due_date);
      if (args.scheduled_for) updates.scheduled_for = parseDateHint(args.scheduled_for);

      if (Object.keys(updates).length === 0) {
        return { error: 'Nothing to update. Provide priority, due_date, or scheduled_for.' };
      }

      const updated = await updateCard(card.id, updates);
      if (!updated) return { error: 'Update failed.' };

      const changes: string[] = [];
      if (args.priority !== undefined) changes.push(`priority → ${args.priority}`);
      if (args.due_date) changes.push(`due → ${new Date(updated.due_date!).toLocaleDateString()}`);
      if (args.scheduled_for) changes.push(`scheduled → ${new Date(updated.scheduled_for!).toLocaleString()}`);

      return {
        success: true,
        message: `Updated "${updated.title}": ${changes.join(', ')}`,
      };
    }

    case 'summary': {
      const summary = await getBoardSummary(chatId);
      return { summary };
    }

    default:
      return { error: `Unknown action: ${args.action}. Use create, list, move, assign, update, or summary.` };
  }
}
