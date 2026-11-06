import { defineHandler, type PluginContextV3 } from '@kb-labs/sdk';
import { requireApiKey, requireTeamId, getWorkspaceHierarchy } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(_ctx: PluginContextV3) {
    try {
      const apiKey = requireApiKey();
      const teamId = requireTeamId();
      return getWorkspaceHierarchy(apiKey, teamId);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
