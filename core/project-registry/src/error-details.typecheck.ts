import { ProjectRegistryError } from './errors.js';

new ProjectRegistryError({ code: 'KB_PROJECT_UNKNOWN', details: { path: '/tmp/project' } }, 'not registered');

// @ts-expect-error Project registry details must match the selected catalogue code.
new ProjectRegistryError({ code: 'KB_PROJECT_UNKNOWN', details: { field: 'project' } }, 'not registered');
