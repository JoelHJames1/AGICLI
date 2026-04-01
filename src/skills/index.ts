// ---------------------------------------------------------------------------
// Skills subsystem — public API
// ---------------------------------------------------------------------------

// Skill loading (existing)
export {
  getSkillsPath,
  getSkillDirCommands,
  clearSkillCaches,
  createSkillCommand,
  parseSkillFrontmatterFields,
  getDynamicSkills,
  clearDynamicSkills,
  addSkillDirectories,
  discoverSkillDirsForPaths,
  onDynamicSkillsLoaded,
  activateConditionalSkillsForPaths,
} from './loadSkillsDir.js'
export type { LoadedFrom } from './loadSkillsDir.js'

// Bundled skills (existing)
export {
  registerBundledSkill,
  getBundledSkills,
  clearBundledSkills,
  getBundledSkillExtractDir,
} from './bundledSkills.js'
export type { BundledSkillDefinition } from './bundledSkills.js'

// Dynamic skill generation (new — Claude2)
export { SkillGenerator } from './skillGenerator.js'
export type {
  ToolHistoryEntry,
  DetectedPattern,
  SkillSuggestion,
} from './skillGenerator.js'

// MCP auto-discovery (new — Claude2)
export { MCPAutoDiscovery } from './mcpAutoDiscovery.js'
export type {
  MCPServerInfo,
  MCPServerSuggestion,
} from './mcpAutoDiscovery.js'
