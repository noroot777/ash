export function gateBootstrapEnvironment(environment: NodeJS.ProcessEnv): {
  bootstrap: NodeJS.ProcessEnv;
  restore: NodeJS.ProcessEnv;
} {
  const bootstrap = { ...environment };
  const restore: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(bootstrap)) {
    if (!/^(?:NODE_OPTIONS|LD_.+|DYLD_.+)$/i.test(key)) continue;
    restore[key] = bootstrap[key];
    delete bootstrap[key];
  }
  return { bootstrap, restore };
}
