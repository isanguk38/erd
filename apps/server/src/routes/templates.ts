import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sanitizeTemplateSettings, type TemplateSettings } from '@erd/core';
import { getJson, putJson, type Storage } from '../storage';

// 컬럼 템플릿은 사람마다 다르므로 계정별로 저장한다 (모든 프로젝트에서 같이 쓴다).

const keyOf = (userId: string) => `users/${createHash('sha256').update(userId).digest('hex').slice(0, 32)}/templates.json`;

export function loadTemplates(storage: Storage, userId: string): TemplateSettings {
  return sanitizeTemplateSettings(getJson(storage, keyOf(userId), { templates: [], defaultTemplateId: null }));
}

export function registerTemplateRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/templates', async (req) => loadTemplates(storage, req.user.id));

  app.put<{ Body: unknown }>('/api/templates', async (req) => {
    const settings = sanitizeTemplateSettings(req.body);
    putJson(storage, keyOf(req.user.id), settings);
    return settings;
  });
}
