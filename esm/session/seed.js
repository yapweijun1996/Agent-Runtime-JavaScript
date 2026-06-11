import { normalizeSeedMessages } from './messages.js';

async function seedSessionHistory(sessionStore, sessionRecord, seedMessages) {
  const normalizedMessages = normalizeSeedMessages(sessionRecord.id, seedMessages);

  for (const message of normalizedMessages) {
    await sessionStore.appendMessage(message);
  }

  if (normalizedMessages.length > 0) {
    sessionRecord.updatedAt = normalizedMessages[normalizedMessages.length - 1].createdAt;
  }

  return normalizedMessages.length;
}

export { seedSessionHistory };
