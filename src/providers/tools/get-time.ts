import type { Tool } from 'ollama';

export const getTimeDefinition: Tool = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current date, time, and timezone.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

export function getTime(): Record<string, string | number> {
  const now = new Date();
  return {
    date: now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    time: now.toLocaleTimeString('en-US', { hour12: true }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    unix: Math.floor(now.getTime() / 1000),
  };
}
