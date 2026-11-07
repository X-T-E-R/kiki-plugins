import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import {
  GROK_CLIENT_ID,
  GROK_ISSUER,
  GROK_SCOPE,
  hashIdentity,
  inspectGrokAuthFile,
  inspectGrokManagedAccounts,
  maskAccountIdentifier,
  resolveGrokNativeLocator,
} from '../lib/grok-native-locator.mjs';
import {
  classifyMagpieSwitchScope,
  MAGPIE_MANAGE_CATALOG,
  MAGPIE_PUBLIC_SETTINGS_REGISTRY,
  MagpieManagementService,
  projectPublicSettingValue,
  sanitizeDiagnosticText,
  validateCredentialFreeProxyInput,
} from '../lib/manage.mjs';
import { stageLiveCompatPlugin } from '../scripts/stage-live-compat.mjs';

function makeSyntheticJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${header}.${payload}.syntheticSignatureDoNotLeak`;
}

function makeGrokOidcAuthJson({
  email,
  userId,
  accessTokenSecret,
  refreshTokenSecret,
  expiresAtSec = 1_893_456_000,
}) {
  const jwt = makeSyntheticJwt({
    sub: userId,
    email,
    exp: expiresAtSec,
    token_probe: accessTokenSecret,
  });
  return {
    [GROK_SCOPE]: {
      auth_mode: 'oidc',
      oidc_issuer: GROK_ISSUER,
      oidc_client_id: GROK_CLIENT_ID,
      key: jwt,
      refresh_token: refreshTokenSecret,
      email,
      user_id: userId,
      expires_at: expiresAtSec,
      create_time: '2026-11-07T00:00:00.000Z',
    },
  };
}

test('distinguishes Magpie gateway switch (`switchSideLogin`) from native harness CLI sign-in (`codex`/`claude`)', () => {
  const grokScope = classifyMagpieSwitchScope('grok');
  assert.equal(grokScope.scope, 'magpie_gateway_only');
  assert.equal(grokScope.nativeHarnessActivated, false);
  assert.equal(grokScope.magpieGatewayUpdated, true);

  const pluginGrokScope = classifyMagpieSwitchScope('plugin:grok');
  assert.equal(pluginGrokScope.scope, 'magpie_gateway_only');
  assert.equal(pluginGrokScope.nativeHarnessActivated, false);

  const agyScope = classifyMagpieSwitchScope('antigravity');
  assert.equal(agyScope.scope, 'magpie_gateway_only');
  assert.equal(agyScope.nativeHarnessActivated, false);

  const codexScope = classifyMagpieSwitchScope('codex');
  assert.equal(codexScope.scope, 'native_cli_and_magpie');
  assert.equal(codexScope.nativeHarnessActivated, true);
  assert.equal(codexScope.magpieGatewayUpdated, true);

  const claudeScope = classifyMagpieSwitchScope('claude');
  assert.equal(claudeScope.scope, 'native_cli_and_magpie');
  assert.equal(claudeScope.nativeHarnessActivated, true);
});

test('resolves Grok native locator for both CLI default home (`~/.grok`) and Magpie plugin private home without copying rotating tokens or leaking secrets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'magpie-grok-locator-'));
  try {
    const magpieConfigDir = path.join(dir, 'magpie-cfg');
    const nativeGrokHome = path.join(dir, 'dot-grok');
    const sessionsDir = path.join(nativeGrokHome, 'sessions');
    const privateSlotHome = path.join(dir, 'opencode-grok-auth', 'slot-backup-seat');
    const retiredEmptyHome = path.join(dir, 'opencode-grok-auth', 'retired-empty-slot');

    await mkdir(magpieConfigDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(privateSlotHome, { recursive: true });
    await mkdir(retiredEmptyHome, { recursive: true });

    const defaultSeatEmail = 'active-cli-seat@example.test';
    const privateSeatEmail = 'private-slot-seat@example.test';
    const oldBackupEmail = 'previous-seat@example.test';

    const secretAccessDefault = 'SECRET_ACCESS_DEFAULT_9911';
    const secretRefreshDefault = 'rt_secret_default_token_never_leak_9911';
    const secretAccessPrivate = 'SECRET_ACCESS_PRIVATE_8822';
    const secretRefreshPrivate = 'rt_secret_private_token_never_leak_8822';
    const secretRefreshOldBak = 'rt_secret_old_bak_token_never_leak_7733';

    await writeFile(
      path.join(nativeGrokHome, 'auth.json'),
      JSON.stringify(makeGrokOidcAuthJson({
        email: defaultSeatEmail,
        userId: 'usr_default_seat',
        accessTokenSecret: secretAccessDefault,
        refreshTokenSecret: secretRefreshDefault,
      })),
      'utf8',
    );
    await writeFile(
      path.join(nativeGrokHome, 'auth.json.bak'),
      JSON.stringify(makeGrokOidcAuthJson({
        email: oldBackupEmail,
        userId: 'usr_old_backup',
        accessTokenSecret: 'SECRET_OLD_BAK',
        refreshTokenSecret: secretRefreshOldBak,
      })),
      'utf8',
    );
    await writeFile(
      path.join(privateSlotHome, 'auth.json'),
      JSON.stringify(makeGrokOidcAuthJson({
        email: privateSeatEmail,
        userId: 'usr_private_seat',
        accessTokenSecret: secretAccessPrivate,
        refreshTokenSecret: secretRefreshPrivate,
      })),
      'utf8',
    );

    await writeFile(path.join(magpieConfigDir, 'logins.json'), JSON.stringify([
      {
        id: 'login-default-home',
        agent: 'plugin:grok',
        user: `${defaultSeatEmail} · (2)`,
        home: 'grok#cli',
        on: true,
        first: true,
        alias: 'CLI Native Seat',
      },
      {
        id: 'login-private-home',
        agent: 'plugin:grok',
        user: privateSeatEmail,
        home: 'grok#priv',
        on: true,
        alias: 'Backup Private Seat',
      },
      {
        id: 'login-retired-empty',
        agent: 'plugin:grok',
        user: 'retired@example.test',
        home: 'grok#retired',
        on: true,
      },
    ]), 'utf8');

    await writeFile(path.join(magpieConfigDir, 'plugin-auth.json'), JSON.stringify({
      'grok#cli': {
        type: 'oauth',
        refresh: nativeGrokHome,
        accountId: defaultSeatEmail,
      },
      'grok#priv': {
        type: 'oauth',
        refresh: privateSlotHome,
        accountId: privateSeatEmail,
      },
      'grok#retired': {
        type: 'oauth',
        refresh: retiredEmptyHome,
        accountId: 'retired@example.test',
      },
    }), 'utf8');

    await writeFile(path.join(magpieConfigDir, 'providers.json'), JSON.stringify({
      providers: [
        {
          id: 'plugin:grok',
          proxy: 'http://proxyUser:superSecretPass@127.0.0.1:7890',
        },
      ],
    }), 'utf8');

    const status = await inspectGrokManagedAccounts({
      magpieConfigDir,
      nativeGrokHome,
      env: {},
    });
    const publicJson = JSON.stringify({ ...status, _internalAccounts: undefined });

    for (const forbidden of [
      secretAccessDefault,
      secretRefreshDefault,
      secretAccessPrivate,
      secretRefreshPrivate,
      secretRefreshOldBak,
      'superSecretPass',
      defaultSeatEmail,
      privateSeatEmail,
      oldBackupEmail,
    ]) {
      assert.equal(publicJson.includes(forbidden), false, `Leaked sensitive string: ${forbidden}`);
    }

    assert.equal(status.magpieGatewaySelection.slotKey, 'grok#cli');
    assert.equal(status.magpieGatewaySelection.isCliNativeHome, true);
    assert.equal(status.magpieGatewaySelection.accountHash, hashIdentity(defaultSeatEmail));
    assert.equal(status.nativeGrokHome.sessionsPreserved, true);
    assert.equal(status.nativeGrokHome.inSyncWithMagpieSelection, true);
    assert.equal(status.nativeGrokHome.recoveryReferences.length, 1);
    assert.equal(status.nativeGrokHome.recoveryReferences[0].accountHash, hashIdentity(oldBackupEmail));

    // Layout 1: Active account is already in CLI native home (`~/.grok`) -> `cli_native_default_home`, no GROK_AUTH_PATH override needed!
    const defaultLocator = await resolveGrokNativeLocator({
      magpieConfigDir,
      nativeGrokHome,
      env: {},
    });
    assert.equal(defaultLocator.liveMutated, false);
    assert.equal(defaultLocator.singleRotatingToken, true);
    assert.equal(defaultLocator.matchedAccount.isCliNativeHome, true);
    assert.equal(defaultLocator.matchedAccount.accountHash, hashIdentity(defaultSeatEmail));
    assert.equal(defaultLocator.matchedAccount.redactedProxy, 'http://127.0.0.1:7890');
    assert.equal(defaultLocator.locator.mode, 'cli_native_default_home');
    assert.equal(defaultLocator.locator.requiresEnvOverride, false);
    assert.deepEqual(defaultLocator.locator.env, {});
    assert.equal(defaultLocator.locator.authFile, path.join(nativeGrokHome, 'auth.json'));

    // Layout 2: Selecting the backup account in a Magpie plugin private home -> `preserve_grok_home_and_sessions` with `GROK_AUTH_PATH`!
    const privateLocator = await resolveGrokNativeLocator({
      account: hashIdentity(privateSeatEmail),
      magpieConfigDir,
      nativeGrokHome,
      env: {},
    });
    assert.equal(privateLocator.matchedAccount.isCliNativeHome, false);
    assert.equal(privateLocator.matchedAccount.accountHash, hashIdentity(privateSeatEmail));
    assert.equal(privateLocator.locator.mode, 'preserve_grok_home_and_sessions');
    assert.equal(privateLocator.locator.requiresEnvOverride, true);
    assert.equal(privateLocator.locator.grokHomeDir, nativeGrokHome);
    assert.deepEqual(privateLocator.locator.env, {
      GROK_AUTH_PATH: path.join(privateSlotHome, 'auth.json'),
    });
    assert.deepEqual(privateLocator.locator.isolatedInstanceAlternative, {
      mode: 'isolated_private_home',
      configuration: {
        kind: 'config_directory',
        path: privateSlotHome,
      },
    });
    assert.equal(privateLocator.preservedState.sessionsPreserved, true);
    assert.equal(privateLocator.preservedState.recoveryReferences.length, 1);

    await assert.rejects(
      resolveGrokNativeLocator({
        account: 'grok#retired',
        magpieConfigDir,
        nativeGrokHome,
        env: {},
      }),
      /does not have a verified ready OIDC auth\.json/,
    );

    const missingInspect = await inspectGrokAuthFile(path.join(retiredEmptyHome, 'auth.json'));
    assert.equal(missingInspect.state, 'signed_out');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enforces public settings registry projection, blocks credentialed proxy argv in settings_set, redacts synthetic opaque Bearer/ya29 tokens, and returns log locator without raw log lines', async () => {
  // 1. Exact synthetic counterexample from main: opaque Bearer + ya29 access_token
  const syntheticLeakSample = 'Authorization: Bearer mock_opaque_secret_789 access_token=ya29.mocksecret123 refresh_token="rt_opaque_999" http://user1:pw_secret_456@127.0.0.1:7890';
  const sanitized = sanitizeDiagnosticText(syntheticLeakSample);
  for (const secret of ['mock_opaque_secret_789', 'ya29.mocksecret123', 'rt_opaque_999', 'pw_secret_456']) {
    assert.equal(sanitized.includes(secret), false, `sanitizeDiagnosticText leaked ${secret}: ${sanitized}`);
  }
  const quotedProbe = 'opaque_probe_value_20261108';
  const quoted = sanitizeDiagnosticText(JSON.stringify({
    access_token: quotedProbe,
    options: { api_key: quotedProbe },
  }));
  assert.equal(quoted.includes(quotedProbe), false);

  // 2. Credentialed proxy input is rejected before spawning any CLI process (`argv` safety)
  assert.throws(
    () => validateCredentialFreeProxyInput('http://proxyUser:proxyPass@127.0.0.1:7890'),
    { code: 'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV' },
  );
  assert.throws(
    () => validateCredentialFreeProxyInput('socks5h://u:p@10.0.0.1:1080'),
    { code: 'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV' },
  );
  assert.equal(validateCredentialFreeProxyInput('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(validateCredentialFreeProxyInput('direct'), 'direct');
  assert.equal(validateCredentialFreeProxyInput(''), '');

  // 3. Public settings projection drops unknown/secret keys and strips OTel header values
  assert.equal(projectPublicSettingValue('githubToken', 'ghp_secret123456789').allowed, false);
  assert.equal(projectPublicSettingValue('lanKey', 'lan_secret_key').allowed, false);
  assert.equal(projectPublicSettingValue('proxyCustom', 'http://u:p@127.0.0.1:7890').allowed, false);
  const projectedOtel = projectPublicSettingValue('otel', {
    enabled: true,
    endpoint: 'https://otelUser:otelSecret@langfuse.example.test/api/public/otel',
    headers: { Authorization: 'Basic c2VjcmV0' },
    metrics: true,
  });
  assert.equal(projectedOtel.allowed, true);
  assert.equal(projectedOtel.value.endpoint, 'https://langfuse.example.test/api/public/otel');
  assert.deepEqual(projectedOtel.value.headerKeys, ['Authorization']);
  assert.equal(JSON.stringify(projectedOtel).includes('c2VjcmV0'), false);
  assert.equal(JSON.stringify(projectedOtel).includes('otelSecret'), false);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'magpie-manage-svc-'));
  try {
    const magpieConfigDir = path.join(dir, 'magpie-cfg');
    await mkdir(magpieConfigDir, { recursive: true });
    await writeFile(path.join(magpieConfigDir, 'settings.json'), JSON.stringify({
      proxy: 'socks5h://u1:secretPass1@127.0.0.1:1080',
    }), 'utf8');
    await writeFile(path.join(magpieConfigDir, 'providers.json'), JSON.stringify({
      providers: [
        {
          id: 'antigravity',
          key: 'sk-shouldNeverAppearAnywhere123456',
          accountProxies: {
            'seat-one@example.test': 'http://agy:secretPass2@127.0.0.1:8080',
          },
        },
      ],
    }), 'utf8');

    const appLogFile = path.join(dir, 'app.log');
    const rotatedLogFile = path.join(dir, 'app.old.log');
    await writeFile(appLogFile, 'raw log line with Authorization: Bearer mock_opaque_secret_789\n', 'utf8');
    await writeFile(rotatedLogFile, 'older log line with access_token=ya29.mocksecret123\n', 'utf8');

    const invocations = [];
    const manager = new MagpieManagementService({
      env: {},
      homedir: dir,
      execCommand: async (_exe, args) => {
        invocations.push(args);
        const key = args.join(' ');
        if (key === 'accounts grok --json') {
          return {
            stdout: JSON.stringify([
              {
                agent: 'plugin:grok',
                user: 'seat-alpha@example.test',
                active: true,
                on: true,
                readAt: '2026-11-08T02:00:00Z',
                windows: [{ name: '7 days', remaining: 100, resetsAt: '2026-11-15T00:00:00Z' }],
              },
              {
                agent: 'plugin:grok',
                user: 'seat-beta@example.test',
                active: false,
                on: false,
                alias: 'Off Seat',
                readAt: '2026-11-08T02:00:00Z',
                windows: [{ name: '7 days', remaining: 90, resetsAt: '2026-11-15T00:00:00Z' }],
              },
            ]),
            stderr: '',
          };
        }
        if (args[0] === 'accounts' && args[1] === 'switch') {
          return { stdout: `Switched ${args[2]} priority to ${maskAccountIdentifier(args[3])}`, stderr: '' };
        }
        if (key === 'quota grok --json') {
          return {
            stdout: JSON.stringify([
              {
                provider: 'plugin:grok',
                name: 'Grok',
                kind: 'subscription',
                user: 'seat-alpha@example.test',
                key: 'sk-secretCardKey123456789',
                windows: [{ name: '7 days', remaining: 100 }],
              },
            ]),
            stderr: '',
          };
        }
        if (key === 'quota history grok --days 7 --json') {
          return {
            stdout: JSON.stringify([
              { provider: 'plugin:grok', user: 'seat-alpha@example.test', points: [{ t: '2026-11-08T00:00:00Z', remaining: 100 }] },
            ]),
            stderr: '',
          };
        }
        if (key === 'usage 7d') {
          return { stdout: '7d total: 1.2M tokens ($4.20) via http://u:pass@127.0.0.1:7890', stderr: '' };
        }
        if (key === 'version') return { stdout: 'magpie 0.9.4', stderr: '' };
        if (key === 'healthcheck') {
          const err = new Error('gateway not running');
          err.exitCode = 1;
          throw err;
        }
        if (key === 'autostart') return { stdout: 'magpie doesn\'t open at login', stderr: '' };
        if (key === 'daemon status') {
          const err = new Error('daemon unsupported on windows');
          err.exitCode = 1;
          throw err;
        }
        if (key === 'log --path') return { stdout: `${appLogFile}\n`, stderr: '' };
        if (key === 'log') {
          return {
            stdout: `${appLogFile}\n  the app's log (Settings › About › Log)\n${rotatedLogFile}\n  the app's log before it\n`,
            stderr: '',
          };
        }
        if (key === 'settings list --json') {
          return {
            stdout: JSON.stringify([
              { key: 'proxy', type: 'text', value: 'socks5h://u1:secretPass1@127.0.0.1:1080', default: 'http://defUser:defPass@127.0.0.1:8080' },
              { key: 'theme', type: 'text', value: 'dark', default: 'system', choices: ['system', 'light', 'dark'] },
              { key: 'otel', type: 'JSON', value: { enabled: true, endpoint: 'https://langfuse.example.test', headers: { Authorization: 'Bearer secret_otel_tok' } }, default: {} },
              { key: 'githubToken', type: 'text', value: 'ghp_secretShouldBeFilteredOut', default: '' },
              { key: 'proxyCustom', type: 'text', value: 'http://customUser:customPass@127.0.0.1:9090', default: '' },
            ]),
            stderr: '',
          };
        }
        if (key === 'settings get proxy --json') {
          return { stdout: JSON.stringify('socks5h://u1:secretPass1@127.0.0.1:1080'), stderr: '' };
        }
        if (key === 'settings set proxy http://127.0.0.1:7890') {
          return { stdout: '✓ proxy http://127.0.0.1:7890', stderr: '' };
        }
        if (key === 'provider pool antigravity --cap=80 --careful=on') {
          return { stdout: 'antigravity pool: seat-one@example.test cap=80% careful=on', stderr: '' };
        }
        if (key === 'plugin list --json') {
          return {
            stdout: JSON.stringify({
              plugins: [{ spec: '@magpie-community/opencode-grok-auth', options: { wire_trace: true } }],
              loaded: [{ spec: '@magpie-community/opencode-grok-auth', provides: ['grok'] }],
              providers: [
                {
                  id: 'grok',
                  spec: '@magpie-community/opencode-grok-auth',
                  name: 'Grok',
                  signedIn: true,
                  authType: 'oauth',
                  accountId: 'seat-alpha@example.test',
                  accounts: [
                    {
                      key: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c3JfMSJ9.secretJwtInPluginList',
                      type: 'oauth',
                      accountId: 'seat-alpha@example.test',
                      models: ['grok-4.7'],
                    },
                  ],
                  models: [{ id: 'grok-4.7' }],
                },
              ],
              middleware: {},
            }),
            stderr: '',
          };
        }
        throw new Error(`Unexpected CLI call: ${key}`);
      },
    });

    const ctx = {
      kikiHome: dir,
      settings: {
        magpiePath: process.execPath,
        magpieConfigDir,
      },
    };

    const caps = await manager.execute({ action: 'capabilities' }, ctx);
    assert.equal(caps.ok, true);
    assert.equal(caps.mutated, false);
    assert.equal(caps.operations.length, MAGPIE_MANAGE_CATALOG.length);

    // 1. settings_list filters out unlisted keys (`githubToken`, `proxyCustom`), strips proxy credentials on both value & default, and strips OTel header secrets
    const settingsList = await manager.execute({ action: 'settings_list' }, ctx);
    assert.deepEqual(settingsList.settings.map((s) => s.key), ['proxy', 'theme', 'otel']);
    assert.equal(settingsList.settings[0].value, 'socks5h://127.0.0.1:1080');
    assert.equal(settingsList.settings[0].default, 'http://127.0.0.1:8080');
    assert.equal(settingsList.settings[2].writable, false);
    assert.deepEqual(settingsList.settings[2].value.headerKeys, ['Authorization']);
    assert.equal(JSON.stringify(settingsList).includes('secret_otel_tok'), false);
    assert.equal(JSON.stringify(settingsList).includes('ghp_secretShouldBeFilteredOut'), false);
    assert.equal(JSON.stringify(settingsList).includes('customPass'), false);

    // 2. settings_get projects proxy safely and rejects keys outside MAGPIE_PUBLIC_SETTINGS_REGISTRY
    const gotProxy = await manager.execute({ action: 'settings_get', key: 'proxy' }, ctx);
    assert.equal(gotProxy.value, 'socks5h://127.0.0.1:1080');
    assert.ok(Object.hasOwn(MAGPIE_PUBLIC_SETTINGS_REGISTRY, 'proxy'));
    await assert.rejects(
      manager.execute({ action: 'settings_get', key: 'githubToken' }, ctx),
      { code: 'MAGPIE_FORBIDDEN_KEY' },
    );

    // 3. settings_set rejects credentialed proxy URLs without spawning Magpie CLI, and allows credential-free proxy URLs
    const callsBeforeBlockedSet = invocations.length;
    await assert.rejects(
      manager.execute({ action: 'settings_set', key: 'proxy', value: 'http://user:pass@127.0.0.1:7890' }, ctx),
      { code: 'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV' },
    );
    await assert.rejects(
      manager.execute({ action: 'settings_set', key: 'otel', value: { enabled: true } }, ctx),
      { code: 'MAGPIE_FORBIDDEN_KEY' },
    );
    assert.equal(invocations.length, callsBeforeBlockedSet, 'Blocked settings_set must not spawn Magpie CLI');

    const setProxyOk = await manager.execute({ action: 'settings_set', key: 'proxy', value: 'http://127.0.0.1:7890' }, ctx);
    assert.equal(setProxyOk.mutated, true);
    assert.equal(setProxyOk.appliedValue, 'http://127.0.0.1:7890');

    // 4. log_locator returns openable file paths + metadata and NEVER reads or returns raw log lines
    const logLoc = await manager.execute({ action: 'log_locator' }, ctx);
    assert.equal(logLoc.mutated, false);
    assert.equal(logLoc.appLogPath, appLogFile);
    assert.equal(logLoc.files.length, 2);
    assert.equal(logLoc.files[0].exists, true);
    assert.equal(typeof logLoc.files[0].sizeBytes, 'number');
    assert.equal(JSON.stringify(logLoc).includes('mock_opaque_secret_789'), false);
    assert.equal(JSON.stringify(logLoc).includes('ya29.mocksecret123'), false);

    // 5. plugins_list strips `accounts[].key` JWTs and raw `accountId` emails
    const pluginsRes = await manager.execute({ action: 'plugins_list' }, ctx);
    assert.equal(pluginsRes.providers[0].accountHash, hashIdentity('seat-alpha@example.test'));
    assert.equal(pluginsRes.providers[0].accounts[0].accountHash, hashIdentity('seat-alpha@example.test'));
    assert.equal(JSON.stringify(pluginsRes).includes('secretJwtInPluginList'), false);
    assert.equal(JSON.stringify(pluginsRes).includes('seat-alpha@example.test'), false);

    // 6. service_status includes structured logs locator & redacted proxy without starting any service
    const svc = await manager.execute({ action: 'service_status' }, ctx);
    assert.equal(svc.mutated, false);
    assert.equal(svc.gatewayAnswering, false);
    assert.equal(svc.logs.appLogPath, appLogFile);
    assert.equal(svc.proxy.globalProxy, 'socks5h://127.0.0.1:1080');
    assert.equal(svc.proxy.providers[0].accountProxies[0].proxy, 'http://127.0.0.1:8080');
    assert.equal(JSON.stringify(svc).includes('secretPass'), false);
    assert.equal(JSON.stringify(svc).includes('sk-shouldNeverAppear'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('supports actionable model, routing group, plugin, daemon, and autostart management operations', async () => {
  const seenCalls = [];
  const manager = new MagpieManagementService({
    env: {},
    execCommand: async (_exe, args) => {
      seenCalls.push(args);
      const cmd = args.join(' ');
      if (cmd === 'models grok') {
        return {
          stdout: [
            '  Routing groups',
            '  auto/grok-4.7                         Grok 4.7  low/medium/high/xhigh',
            '  Grok',
            '  grok/grok-4.7                         Grok 4.7  low/medium/high/xhigh',
            '  http://127.0.0.1:3425/v1',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'model name grok/grok-4.7 Grok 4.7 Main') {
        return { stdout: '✓ grok/grok-4.7 is called Grok 4.7 Main', stderr: '' };
      }
      if (cmd === 'model efforts grok/grok-4.7 low,medium,high') {
        return { stdout: '✓ grok/grok-4.7 offers low, medium, high', stderr: '' };
      }
      if (cmd === 'model api grok/grok-4.7 responses') {
        return { stdout: '✓ grok/grok-4.7 asked on Responses', stderr: '' };
      }
      if (cmd === 'model spec grok/grok-4.7 --context 272k --output 128k --vision on --reasoning low,high') {
        return { stdout: '✓ grok/grok-4.7 spec updated', stderr: '' };
      }
      if (cmd === 'model disable grok/grok-4.5') {
        return { stdout: '✓ grok/grok-4.5 disabled', stderr: '' };
      }
      if (cmd === 'sync') {
        return { stdout: '✓ catalog saved', stderr: '' };
      }
      if (cmd === 'groups') {
        return { stdout: '  Grok 4.7 found  auto/grok-4.7  smart  grok/grok-4.7 · workbuddy-ai/grok-4.7\n', stderr: '' };
      }
      if (cmd === 'group add Fast Coding models=grok/grok-4.7,antigravity/gemini-3.8-flash routing=usage stays=session') {
        return { stdout: '✓ added Fast Coding · agents pick it as group/fast-coding', stderr: '' };
      }
      if (cmd === 'group set fast-coding models+=workbuddy-ai/grok-4.7 routing=pace') {
        return { stdout: '✓ saved Fast Coding', stderr: '' };
      }
      if (cmd === 'group pick fast-coding grok/grok-4.7') {
        return { stdout: '✓ Fast Coding sends every request to grok/grok-4.7 · routing manual', stderr: '' };
      }
      if (cmd === 'group rm fast-coding') {
        return { stdout: '✓ removed Fast Coding', stderr: '' };
      }
      if (cmd === 'plugin on @magpie-community/opencode-grok-auth') {
        return { stdout: '✓ @magpie-community/opencode-grok-auth is on', stderr: '' };
      }
      if (cmd === 'plugin options @magpie-community/opencode-grok-auth {"wire_trace":true}') {
        return { stdout: '✓ wire_trace is on for grok', stderr: '' };
      }
      if (cmd === 'plugin builtin off sessions') {
        return { stdout: '○ sessions off', stderr: '' };
      }
      if (cmd === 'daemon restart') {
        return { stdout: '✓ the magpie service is restarted\n● the gateway answers on http://127.0.0.1:3425', stderr: '' };
      }
      if (cmd === 'daemon web on --addr 127.0.0.1:3430') {
        return { stdout: '  page    http://127.0.0.1:3430/?k=secretWebKeyShouldBeRedacted123456', stderr: '' };
      }
      if (cmd === 'autostart on') {
        return { stdout: '✓ magpie opens at login, in the tray', stderr: '' };
      }
      throw new Error(`Unexpected CLI call: ${cmd}`);
    },
  });

  const ctx = { settings: { magpiePath: process.execPath } };

  // 1. models_list & model_manage & sync_catalog
  const modelsRes = await manager.execute({ action: 'models_list', agent: 'grok' }, ctx);
  assert.equal(modelsRes.totalModels, 2);
  assert.equal(modelsRes.gatewayEndpoint, 'http://127.0.0.1:3425/v1');

  const renamed = await manager.execute({
    action: 'model_manage',
    subcommand: 'name',
    target: 'grok/grok-4.7',
    name: 'Grok 4.7 Main',
  }, ctx);
  assert.equal(renamed.mutated, true);

  const effortsSet = await manager.execute({
    action: 'model_manage',
    subcommand: 'efforts',
    target: 'grok/grok-4.7',
    efforts: ['low', 'medium', 'high'],
  }, ctx);
  assert.equal(effortsSet.mutated, true);

  const apiSet = await manager.execute({
    action: 'model_manage',
    subcommand: 'api',
    target: 'grok/grok-4.7',
    api: 'responses',
  }, ctx);
  assert.equal(apiSet.mutated, true);

  const specSet = await manager.execute({
    action: 'model_manage',
    subcommand: 'spec',
    target: 'grok/grok-4.7',
    contextTokens: '272k',
    outputTokens: '128k',
    vision: true,
    efforts: ['low', 'high'],
  }, ctx);
  assert.equal(specSet.mutated, true);

  const disabledModel = await manager.execute({
    action: 'model_manage',
    subcommand: 'disable',
    target: 'grok/grok-4.5',
  }, ctx);
  assert.equal(disabledModel.mutated, true);

  const synced = await manager.execute({ action: 'sync_catalog' }, ctx);
  assert.equal(synced.mutated, true);

  // 2. groups_list & group_manage (add / set / pick / rm)
  const groupsRes = await manager.execute({ action: 'groups_list' }, ctx);
  assert.equal(groupsRes.count, 1);

  const groupAdded = await manager.execute({
    action: 'group_manage',
    subcommand: 'add',
    name: 'Fast Coding',
    models: ['grok/grok-4.7', 'antigravity/gemini-3.8-flash'],
    routing: 'usage',
    stays: 'session',
  }, ctx);
  assert.equal(groupAdded.mutated, true);

  const groupUpdated = await manager.execute({
    action: 'group_manage',
    subcommand: 'set',
    target: 'fast-coding',
    modelsAdd: ['workbuddy-ai/grok-4.7'],
    routing: 'pace',
  }, ctx);
  assert.equal(groupUpdated.mutated, true);

  const groupPicked = await manager.execute({
    action: 'group_manage',
    subcommand: 'pick',
    target: 'fast-coding',
    model: 'grok/grok-4.7',
  }, ctx);
  assert.equal(groupPicked.mutated, true);

  const groupRemoved = await manager.execute({
    action: 'group_manage',
    subcommand: 'rm',
    target: 'fast-coding',
  }, ctx);
  assert.equal(groupRemoved.mutated, true);

  // 3. plugin_manage (on / options / builtin + blocks secret option keys)
  const pluginOn = await manager.execute({
    action: 'plugin_manage',
    subcommand: 'on',
    target: '@magpie-community/opencode-grok-auth',
  }, ctx);
  assert.equal(pluginOn.mutated, true);

  const pluginOpts = await manager.execute({
    action: 'plugin_manage',
    subcommand: 'options',
    target: '@magpie-community/opencode-grok-auth',
    options: { wire_trace: true },
  }, ctx);
  assert.equal(pluginOpts.mutated, true);

  await assert.rejects(
    manager.execute({
      action: 'plugin_manage',
      subcommand: 'options',
      target: '@magpie-community/opencode-grok-auth',
      options: { api_key: 'sk-secret' },
    }, ctx),
    { code: 'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV' },
  );

  const builtinOff = await manager.execute({
    action: 'plugin_manage',
    subcommand: 'builtin',
    target: 'sessions',
    enabled: false,
  }, ctx);
  assert.equal(builtinOff.mutated, true);

  // 4. daemon_manage & autostart_manage (and redacts web `?k=` session key!)
  const daemonRestart = await manager.execute({
    action: 'daemon_manage',
    subcommand: 'restart',
  }, ctx);
  assert.equal(daemonRestart.mutated, true);

  const daemonWeb = await manager.execute({
    action: 'daemon_manage',
    subcommand: 'web',
    enabled: true,
    addr: '127.0.0.1:3430',
  }, ctx);
  assert.equal(daemonWeb.mutated, true);
  assert.equal(daemonWeb.output.includes('secretWebKeyShouldBeRedacted123456'), false);
  assert.equal(daemonWeb.output.includes('/?k=[redacted]'), true);

  const autostartOn = await manager.execute({
    action: 'autostart_manage',
    subcommand: 'on',
  }, ctx);
  assert.equal(autostartOn.mutated, true);
  assert.equal(autostartOn.enabled, true);
});

test('stageLiveCompatPlugin refuses to overwrite existing non-empty custom directories (preserving existing files) and executes magpie_manage over pinned 0.4.3 hostRunner RPC', async () => {
  const runnerPath = path.resolve(process.env.KIKI_HOST_RUNNER ?? '.tmp/hostRunner.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'magpie-live-compat-'));
  try {
    // 1. Passing an existing non-empty directory to stageLiveCompatPlugin MUST fail closed and preserve existing files!
    const occupiedDir = path.join(dir, 'occupied-user-folder');
    await mkdir(occupiedDir, { recursive: true });
    const sentinelFile = path.join(occupiedDir, 'keep-me.txt');
    await writeFile(sentinelFile, 'precious-user-data-do-not-delete\n', 'utf8');

    await assert.rejects(
      stageLiveCompatPlugin({ outputDir: occupiedDir }),
      /Refusing to overwrite existing non-empty directory/,
    );
    assert.equal(await readFile(sentinelFile, 'utf8'), 'precious-user-data-do-not-delete\n');

    // 2. Staging into a fresh (non-existent) directory succeeds and runs cleanly on Kiki 0.4.3 hostRunner
    const compatOutDir = path.join(dir, 'magpie-harness-quota-compat');
    const staged = await stageLiveCompatPlugin({ outputDir: compatOutDir });
    assert.equal(staged.pluginId, 'magpie-harness-quota');
    assert.equal(staged.version, '0.1.1');

    const magpieConfigDir = path.join(dir, 'magpie-cfg');
    const nativeGrokHome = path.join(dir, 'dot-grok');
    await mkdir(magpieConfigDir, { recursive: true });
    await mkdir(path.join(nativeGrokHome, 'sessions'), { recursive: true });
    await writeFile(
      path.join(nativeGrokHome, 'auth.json'),
      JSON.stringify(makeGrokOidcAuthJson({
        email: 'live-ready@example.test',
        userId: 'usr_live_ready',
        accessTokenSecret: 'DO_NOT_LEAK_AT',
        refreshTokenSecret: 'DO_NOT_LEAK_RT',
      })),
      'utf8',
    );
    await writeFile(path.join(magpieConfigDir, 'logins.json'), JSON.stringify([
      {
        id: 'slot-1',
        agent: 'plugin:grok',
        user: 'live-ready@example.test',
        home: 'grok',
        on: true,
        first: true,
      },
    ]), 'utf8');
    await writeFile(path.join(magpieConfigDir, 'plugin-auth.json'), JSON.stringify({
      grok: {
        type: 'oauth',
        refresh: nativeGrokHome,
        accountId: 'live-ready@example.test',
      },
    }), 'utf8');

    const child = spawn(process.execPath, [runnerPath, path.join(compatOutDir, 'entry.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const incoming = createInterface({ input: child.stdout });
    const send = (payload) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
    const registeredTools = [];
    const registeredQuotaSources = [];

    try {
      const rpcResponse = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('0.4.3 compat hostRunner RPC timed out')), 10_000);
        incoming.on('line', (line) => {
          const msg = JSON.parse(line);
          if (msg.method === 'register') {
            registeredTools.push(msg.params.tool);
          } else if (msg.method === 'register-harness-quota-source') {
            registeredQuotaSources.push(msg.params.definition);
          } else if (msg.method === 'ready') {
            send({
              id: 1,
              method: 'execute',
              params: {
                name: 'magpie_manage',
                kikiHome: dir,
                settings: {
                  magpiePath: process.execPath,
                  magpieConfigDir,
                },
                args: {
                  action: 'grok_native_locator',
                  nativeGrokHome,
                },
              },
            });
          } else if (msg.id === 1) {
            clearTimeout(timer);
            resolve(msg);
          }
        });
        child.once('error', reject);
        send({ id: 0, method: 'handshake', params: { version: 1 } });
      });

      assert.equal(registeredTools.length, 1);
      assert.equal(registeredTools[0].name, 'magpie_manage');
      assert.equal(registeredQuotaSources.length, 0);

      assert.equal(rpcResponse.error, undefined);
      assert.equal(rpcResponse.result.isError, undefined);
      const payload = JSON.parse(rpcResponse.result.output);
      assert.equal(payload.ok, true);
      assert.equal(payload.action, 'grok_native_locator');
      assert.equal(payload.matchedAccount.isCliNativeHome, true);
      assert.equal(payload.locator.mode, 'cli_native_default_home');
      assert.equal(payload.locator.requiresEnvOverride, false);
      assert.equal(rpcResponse.result.output.includes('DO_NOT_LEAK'), false);
      assert.equal(rpcResponse.result.output.includes('live-ready@example.test'), false);
    } finally {
      child.kill();
      incoming.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugin_manage options and dump project public fields and drop unparsed JSON bodies', async () => {
  const probe = 'opaque_probe_value_20261108';
  let stdout = JSON.stringify({ access_token: probe, options: { api_key: probe } });
  const manager = new MagpieManagementService({
    execCommand: async () => ({ stdout, stderr: '' }),
  });
  const ctx = { settings: { magpiePath: process.execPath } };

  const redOptions = await manager.execute({
    action: 'plugin_manage',
    subcommand: 'options',
    target: 'example-plugin',
  }, ctx);
  assert.equal(JSON.stringify(redOptions).includes(probe), false);
  assert.equal(redOptions.options.access_token, undefined);
  assert.equal(redOptions.options.options.api_key, undefined);

  const redDump = await manager.execute({ action: 'plugin_manage', subcommand: 'dump' }, ctx);
  assert.equal(JSON.stringify(redDump).includes(probe), false);
  assert.equal(redDump.dump.access_token, undefined);
  assert.deepEqual(redDump.dump.plugins, []);

  stdout = `{"access_token":"${probe}"`;
  const badOptions = await manager.execute({
    action: 'plugin_manage',
    subcommand: 'options',
    target: 'example-plugin',
  }, ctx);
  assert.equal(badOptions.parseError, 'plugin options JSON could not be parsed');
  assert.equal(badOptions.output, '');
  assert.equal(JSON.stringify(badOptions).includes(probe), false);

  const badDump = await manager.execute({ action: 'plugin_manage', subcommand: 'dump' }, ctx);
  assert.equal(badDump.parseError, 'plugin dump JSON could not be parsed');
  assert.equal(badDump.dump, null);
  assert.equal(JSON.stringify(badDump).includes(probe), false);

  stdout = JSON.stringify({ wire_trace: true, label: 'public-label', api_key: probe });
  const greenOptions = await manager.execute({
    action: 'plugin_manage',
    subcommand: 'options',
    target: 'example-plugin',
  }, ctx);
  assert.equal(greenOptions.options.wire_trace, true);
  assert.equal(greenOptions.options.label, 'public-label');
  assert.equal(greenOptions.options.api_key, undefined);
  assert.equal(JSON.stringify(greenOptions).includes(probe), false);

  stdout = 'No options set.';
  const textOptions = await manager.execute({
    action: 'plugin_manage',
    subcommand: 'options',
    target: 'example-plugin',
  }, ctx);
  assert.equal(textOptions.output, 'No options set.');
  assert.equal(textOptions.options, undefined);

  stdout = JSON.stringify({
    file: 'C:/magpie/plugins.yml',
    there: true,
    preset: 'all',
    api: '1.0',
    access_token: probe,
    options: { api_key: probe },
    plugins: [{
      id: 'routing',
      enabled: true,
      source: 'user',
      chosen: true,
      inUse: 2,
      state: 'active',
      why: `failed "api_key":"${probe}"`,
      config: { wire_trace: true, api_key: probe, endpoint: 'https://example.test/hook' },
      configSources: { wire_trace: 'user', api_key: 'user', endpoint: 'user' },
    }],
  });
  const greenDump = await manager.execute({ action: 'plugin_manage', subcommand: 'dump' }, ctx);
  assert.equal(greenDump.dump.file, 'C:/magpie/plugins.yml');
  assert.equal(greenDump.dump.there, true);
  assert.equal(greenDump.dump.preset, 'all');
  assert.equal(greenDump.dump.api, '1.0');
  assert.equal(greenDump.dump.plugins.length, 1);
  assert.equal(greenDump.dump.plugins[0].id, 'routing');
  assert.equal(greenDump.dump.plugins[0].inUse, 2);
  assert.equal(greenDump.dump.plugins[0].state, 'active');
  assert.equal(greenDump.dump.plugins[0].config.wire_trace, true);
  assert.equal(greenDump.dump.plugins[0].config.endpoint, 'https://example.test/hook');
  assert.equal(greenDump.dump.plugins[0].config.api_key, undefined);
  assert.deepEqual(greenDump.dump.plugins[0].configSources, { wire_trace: 'user', endpoint: 'user' });
  assert.equal(greenDump.dump.plugins[0].why.includes(probe), false);
  assert.equal(JSON.stringify(greenDump).includes(probe), false);
});

test('projects options JSON after Magpie CLI text and validates options arrays before invoking it', async () => {
  const opaque = 'opaque_probe_value_20261108';
  const input = { action: 'plugin_manage', subcommand: 'options', target: 'example-plugin' };
  const prelude = 'wire_trace  example on  Trace requests\nNo options set. Its package suggests:';
  let stdout = `${prelude}\n${JSON.stringify({ headers: { Authorization: opaque }, wire_trace: true }, null, 2)}`;
  const invocations = [];
  const manager = new MagpieManagementService({
    execCommand: async (_exe, args) => {
      invocations.push(args);
      return { stdout, stderr: '' };
    },
  });
  const read = await manager.execute(input);
  assert.ok(read.output.startsWith(prelude));
  assert.equal(read.options.wire_trace, true);
  assert.equal(JSON.stringify(read).includes(opaque), false);

  stdout = `${prelude}\n{"headers":{"Authorization":"${opaque}"`;
  const invalid = await manager.execute(input);
  assert.equal(invalid.output, prelude);
  assert.equal(invalid.parseError, 'plugin options JSON could not be parsed');

  for (const options of [
    { profiles: [{ api_key: opaque }] },
    { endpoints: [`https://example:${opaque}@example.test`] },
  ]) {
    await assert.rejects(manager.execute({ ...input, options }), { code: 'MAGPIE_CREDENTIAL_NOT_ALLOWED_IN_ARGV' });
  }
  assert.equal(invocations.length, 2);
  const options = { profiles: [{ enabled: true }], endpoints: ['https://example.test'] };
  stdout = '';
  assert.equal((await manager.execute({ ...input, options })).mutated, true);
  assert.deepEqual(JSON.parse(invocations.at(-1).at(-1)), options);
});

test('stageLiveCompatPlugin recycles only directories that already carry its marker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-stage-contract-'));
  try {
    const unmarkedDefault = path.join(root, 'default-unmarked');
    await mkdir(unmarkedDefault, { recursive: true });
    const keepFile = path.join(unmarkedDefault, 'keep.txt');
    await writeFile(keepFile, 'keep-unmarked\n', 'utf8');
    await assert.rejects(
      stageLiveCompatPlugin({ compatStageDir: unmarkedDefault }),
      /Refusing to overwrite existing non-empty directory/,
    );
    assert.equal(await readFile(keepFile, 'utf8'), 'keep-unmarked\n');

    const foreign = path.join(root, 'foreign-marker');
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, '.kiki-live-compat-stage.json'), JSON.stringify({
      kind: 'kiki-0.4.3-live-compat',
      pluginId: 'other-plugin',
    }), 'utf8');
    const foreignKeep = path.join(foreign, 'keep.txt');
    await writeFile(foreignKeep, 'keep-foreign\n', 'utf8');
    await assert.rejects(
      stageLiveCompatPlugin({ outputDir: foreign }),
      /Refusing to overwrite existing non-empty directory/,
    );
    assert.equal(await readFile(foreignKeep, 'utf8'), 'keep-foreign\n');

    const custom = path.join(root, 'custom-staged');
    const first = await stageLiveCompatPlugin({ outputDir: custom });
    const stale = path.join(custom, 'stale.txt');
    await writeFile(stale, 'stale\n', 'utf8');
    const second = await stageLiveCompatPlugin({ outputDir: custom });
    assert.equal(second.outputDir, first.outputDir);
    await assert.rejects(() => readFile(stale, 'utf8'));
    const marker = JSON.parse(await readFile(path.join(custom, '.kiki-live-compat-stage.json'), 'utf8'));
    assert.equal(marker.pluginId, 'magpie-harness-quota');
    assert.equal(marker.kind, 'kiki-0.4.3-live-compat');
    const stagedLib = await readFile(path.join(custom, 'lib', 'antigravity-direct-quota.mjs'), 'utf8');
    assert.equal(stagedLib.includes('googleusercontent.com'), false);
    assert.equal(stagedLib.includes('GOCSPX-'), false);

    const markedDefault = path.join(root, 'default-marked');
    await stageLiveCompatPlugin({ compatStageDir: markedDefault });
    const staleDefault = path.join(markedDefault, 'stale-default.txt');
    await writeFile(staleDefault, 'stale\n', 'utf8');
    const restaged = await stageLiveCompatPlugin({ compatStageDir: markedDefault });
    assert.equal(restaged.outputDir, markedDefault);
    await assert.rejects(() => readFile(staleDefault, 'utf8'));
    const compatManifest = JSON.parse(await readFile(path.join(markedDefault, 'kimi.plugin.json'), 'utf8'));
    assert.equal(compatManifest['x-kiki'].harnessQuotaSources, undefined);
    assert.equal(compatManifest['x-kiki'].permissions.secrets, true);
    assert.equal(compatManifest['x-kiki'].settings.schema.properties.antigravityOAuthClientSecret.secret, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
