const cases = [
  [
    "permissions",
    "foreign-request",
    "CurrentRequestOnly",
    "/\\ offered = current",
    "/\\ TRUE",
  ],
  [
    "permissions",
    "autoallow-forced",
    "ForcedAskRequiresReply",
    "/\\ ~forced",
    "/\\ TRUE",
  ],
  [
    "services",
    "old-health-result",
    "CurrentCallbackOnly",
    "/\\ offered = generation",
    "/\\ TRUE",
  ],
  [
    "services",
    "disposed-health-result",
    "NoDisposedPublish",
    "/\\ ~disposed\n",
    "/\\ TRUE\n",
  ],
  [
    "changes",
    "stale-hunk-selection",
    "CurrentPatchOnly",
    "/\\ offered = current",
    "/\\ TRUE",
  ],
  [
    "changes",
    "discard-unrepresented-index",
    "PreserveUnrepresentedIndex",
    "/\\ representable /\\ wrote",
    "/\\ TRUE /\\ wrote",
  ],
  [
    "provisioning",
    "continue-after-failure",
    "NoStageAfterFailure",
    "/\\ ~failed /\\ ~aborted",
    "/\\ ~aborted",
  ],
  [
    "provisioning",
    "ignore-observed-abort",
    "NoStageAfterObservedAbort",
    "/\\ ~failed /\\ ~aborted",
    "/\\ ~failed",
  ],
];
export const probes = cases.map(([document, name, rule, before, after]) => ({
  document,
  name,
  expectedRules: [rule],
  mutate(spec) {
    if (spec.split(before).length !== 2)
      throw new Error("Mutation target must match once");
    return spec.replace(before, after);
  },
}));
