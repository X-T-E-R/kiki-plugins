# Third-Party Notices

This plugin bundles the following third-party open-source software in `vendor/`:

## rfb2

- **Version**: 1.1.0
- **License**: MIT (full license text preserved in `vendor/rfb2/LICENSE`)
- **Upstream Repository**: https://github.com/sidorares/node-rfb2 (commit `5210ebe482`)
- **Package Source**: npm `rfb2@1.1.0` (`rfb2-1.1.0.tgz`, SHA-256 `cd86dad6c23727a6f4202f4199fb35c0076a8be6743b2832ae72daa3fa05a7d6`)
- **Runtime Dependencies**: None (uses only Node.js built-in modules)
- **Packaging Note**: Precompiled ESM runtime files from `dist/*.js`, `package.json`, and `LICENSE` are included verbatim (`.d.ts` and `.map` development files omitted).

## Keycode Mapping Data Reference

- `lib/xt-scancode-map.mjs` derives AT Set-1 / RFB QEMU Extended Key Event scancodes and X11 keysyms from the public QEMU `keycodemapdb` mapping tables (`https://github.com/qemu/keycodemapdb`, dual-licensed MIT / GPL-2.0+).
