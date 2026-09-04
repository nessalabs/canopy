/** @responsibility Reads what a Codex session can do from the app-server, which is the only place that answers. */

import type {
  AgentCapabilities,
  CapabilityHook,
  CapabilityModel,
  CapabilityPluginSource,
  CapabilitySkill,
} from "../../capabilities"
import { asArray, asNumber, asRecord, asString } from "../../json"
import type { JsonValue } from "../../json"

/**
 * Codex reports capabilities on a different channel from its stream.
 *
 * `codex exec --json` opens with a thread id and nothing else — no model list,
 * no skills, no plugins — so a composer built on that stream has nothing to
 * populate its pickers with. The interactive `codex app-server` answers
 * `model/list`, `skills/list`, `plugin/list` and `hooks/list` on request.
 *
 * This module reads those replies. It does **not** speak to the app-server:
 * holding that connection is a host's job, and this stays a pure function over
 * whatever the host got back — which is also what makes it testable against a
 * captured reply.
 */



/** The app-server methods this reads, so a host knows what to ask for. */
export const CODEX_CAPABILITY_METHODS = Object.freeze([
  "model/list",
  "skills/list",
  "plugin/list",
  "hooks/list",
] as const)

export type CodexCapabilityMethod = (typeof CODEX_CAPABILITY_METHODS)[number]

/**
 * Reads the app-server's replies, keyed by the method that produced each.
 *
 * A method the host never asked about reads as `null`, not as an empty list:
 * the shared contract reserves null for "this provider cannot report it", and
 * an empty array tells a picker the installation *has* none. A reply that came
 * back empty really is empty, and stays `[]`.
 */
export function codexCapabilities(replies: Readonly<Record<string, JsonValue>>): AgentCapabilities {
  const models: CapabilityModel[] = []
  for (const entry of asArray(asRecord(replies["model/list"]).data)) {
    const model = asRecord(entry)
    const id = asString(model.id)
    if (id === null) continue
    models.push({
      id,
      label: asString(model.displayName) ?? id,
      description: asString(model.description),
      isDefault: model.isDefault === true,
    })
  }

  // Skills and hooks are reported per working directory, since both can be
  // defined by the project as well as the user.
  const skills: CapabilitySkill[] = []
  for (const scope of asArray(asRecord(replies["skills/list"]).data)) {
    for (const entry of asArray(asRecord(scope).skills)) {
      const skill = asRecord(entry)
      const name = asString(skill.name)
      if (name === null) continue
      skills.push({ name, description: asString(skill.description) })
    }
  }

  const hooks: CapabilityHook[] = []
  for (const scope of asArray(asRecord(replies["hooks/list"]).data)) {
    for (const entry of asArray(asRecord(scope).hooks)) {
      const hook = asRecord(entry)
      // The reply names these `eventName` and `sourcePath`; `source` beside
      // them is the *kind* of source ("plugin"), not where it came from, so
      // reading it as the location returns the same word for every hook.
      hooks.push({ event: asString(hook.eventName), source: asString(hook.sourcePath) })
    }
  }

  const pluginSources: CapabilityPluginSource[] = []
  for (const entry of asArray(asRecord(replies["plugin/list"]).marketplaces)) {
    const marketplace = asRecord(entry)
    const name = asString(marketplace.name)
    if (name === null) continue
    const sample = asArray(marketplace.plugins)
      .map((plugin) => asString(asRecord(plugin).name) ?? asString(asRecord(plugin).id))
      .filter((name): name is string => name !== null)
    pluginSources.push({
      name,
      // The reply carries the true size when the sample is trimmed; without it
      // the sample's length is the best available answer.
      count: asNumber(marketplace.pluginCount) ?? sample.length,
      sample,
    })
  }

  return {
    // The app-server answers about the installation, not about one thread, so
    // the session's own identity is not part of this reply.
    sessionId: null,
    model: null,
    cwd: null,
    permissionMode: null,
    // A method the host never asked about is unreported, which is not the same
    // as answered-with-nothing.
    models: "model/list" in replies ? models : null,
    skills: "skills/list" in replies ? skills : null,
    hooks: "hooks/list" in replies ? hooks : null,
    pluginSources: "plugin/list" in replies ? pluginSources : null,
    // Null rather than empty: Codex has these concepts, this reply does not
    // carry them, and a picker should omit the section rather than show it bare.
    commands: null,
    agents: null,
    tools: null,
    mcpServers: null,
    plugins: null,
  }
}
