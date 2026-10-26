let input = '';
for await (const chunk of process.stdin) input += chunk;
console.error('upstream fixture stderr');
console.log(JSON.stringify({
  args: process.argv.slice(2), input,
  telemetry: process.env.MOBILEMCP_DISABLE_TELEMETRY,
  ignoreScripts: process.env.npm_config_ignore_scripts,
  cache: process.env.npm_config_cache,
}));
process.exitCode = Number(process.env.KIKI_PHONE_FIXTURE_EXIT_CODE || 0);
