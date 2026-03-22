import type { Tool } from 'ollama';
import {
  createCard,
  moveCard,
  assignCard,
  listCards,
  getCardByPrefix,
  getBoardSummary,
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
- SUMMARY to show board overview

ASSIGNMENT RULES (follow strictly):
- DEFAULT assignee is always "me" (user) — never self-assign to "bot" unless the user explicitly asks
- Use "bot" ONLY when user says: "please take care of X", "can you handle X", "you do this"
- Use "me" when user says: "I will do X", "I'll handle this"
- Use "collaborative" when user says: "let's work on this together"
- Use "noted" for reference-only items: "just note this", "FYI"
- When in doubt, use "me"

Be PROACTIVE about creating cards. Be CONSERVATIVE about assignment.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: create, list, move, assign, summary',
          enum: ['create', 'list', 'move', 'assign', 'summary'],
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
      },
      required: ['action'],
    },
  },
};

export function kanbanManage(
  args: {
    action: string;
    title?: string;
    description?: string;
    cardId?: string;
    status?: string;
    assignee?: string;
    priority?: number;
    labels?: string;
  },
  chatId: string,
): Record<string, unknown> {
  switch (args.action) {
    case 'create': {
      if (!args.title) return { error: 'Title is required for create action.' };

      const labels = args.labels?.split(',').map((l) => l.trim()).filter(Boolean);
      const card = createCard(chatId, args.title, {
        description: args.description,
        assignee: (args.assignee as CardAssignee) || 'me',
        priority: args.priority || 3,
        labels,
        source: 'bot',
      });

      logger.info({ cardId: card.id, chatId, title: card.title }, 'AI created kanban card');
      return {
        success: true,
        cardId: card.id,
        message: `📋 Card created: "${card.title}" [${card.assignee}] — ID: ${card.id.slice(0, 8)}`,
      };
    }

    case 'list': {
      const status = args.status as CardStatus | undefined;
      const cards = listCards(chatId, status);

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

      const card = getCardByPrefix(chatId, args.cardId);
      if (!card) return { error: `Card "${args.cardId}" not found.` };

      const updated = moveCard(card.id, args.status as CardStatus);
      if (!updated) return { error: `Invalid status: ${args.status}` };

      return {
        success: true,
        message: `Moved "${updated.title}" → ${updated.status}`,
      };
    }

    case 'assign': {
      if (!args.cardId) return { error: 'cardId is required for assign action.' };
      if (!args.assignee) return { error: 'assignee is required for assign action.' };

      const card = getCardByPrefix(chatId, args.cardId);
      if (!card) return { error: `Card "${args.cardId}" not found.` };

      const updated = assignCard(card.id, args.assignee as CardAssignee);
      if (!updated) return { error: `Invalid assignee: ${args.assignee}` };

      return {
        success: true,
        message: `Assigned "${updated.title}" → ${updated.assignee}`,
      };
    }

    case 'summary': {
      const summary = getBoardSummary(chatId);
      return { summary };
    }

    default:
      return { error: `Unknown action: ${args.action}. Use create, list, move, assign, or summary.` };
  }
}
