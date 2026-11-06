import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestPlatform } from '@kb-labs/sdk/testing';
import { addTopic, listTopics, resolveTopic } from '../../src/core/functions/topic.js';

describe('topic functions', () => {
  beforeEach(() => {
    setupTestPlatform();
  });

  afterEach(() => {
    setupTestPlatform();
  });

  describe('addTopic', () => {
    it('registers a topic with aliases', async () => {
      const topic = await addTopic({ name: 'frontend', aliases: ['фронт', 'front-end'] });

      expect(topic.id).toBeDefined();
      expect(topic.name).toBe('frontend');
      expect(topic.aliases).toEqual(['фронт', 'front-end']);
    });
  });

  describe('listTopics', () => {
    it('lists topics sorted by name', async () => {
      await addTopic({ name: 'zeta', aliases: [] });
      await addTopic({ name: 'alpha', aliases: [] });

      const topics = await listTopics();
      expect(topics.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    });
  });

  describe('resolveTopic', () => {
    it('resolves an exact name match to the canonical name', async () => {
      await addTopic({ name: 'frontend', aliases: ['front-end'] });
      expect(await resolveTopic('frontend')).toBe('frontend');
    });

    it('resolves an alias to the canonical name', async () => {
      await addTopic({ name: 'frontend', aliases: ['фронт', 'front-end'] });
      expect(await resolveTopic('front-end')).toBe('frontend');
      expect(await resolveTopic('фронт')).toBe('frontend');
    });

    it('matches case-insensitively on both name and alias', async () => {
      await addTopic({ name: 'frontend', aliases: ['Front-End'] });
      expect(await resolveTopic('FRONTEND')).toBe('frontend');
      expect(await resolveTopic('FRONT-END')).toBe('frontend');
    });

    it('falls back to the raw input when nothing in the dictionary matches', async () => {
      await addTopic({ name: 'frontend', aliases: ['front-end'] });
      expect(await resolveTopic('grafana')).toBe('grafana');
    });

    it('falls back to the raw input when the dictionary is empty', async () => {
      expect(await resolveTopic('anything')).toBe('anything');
    });
  });
});
