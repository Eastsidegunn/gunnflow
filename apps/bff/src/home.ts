/**
 * The per-user Gunnflow home: where a person's own settings live, outside the
 * code folder. `GUNNFLOW_HOME` names it; the default is `~/.gunnflow`.
 *
 * The resolution itself lives in scripts/gunnflow-settings.mjs — one source for
 * the BFF, the web build and the scripts, so they cannot drift apart.
 */
export {
  displayPath,
  gunnflowHome,
  loadUserConfig,
  resolveConfigFile,
  resolveWiringDir,
  type ConfigLocation,
  type ConfigSource,
} from '../../../scripts/gunnflow-settings.mjs';
