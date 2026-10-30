# Third-party notices

The ES query parser, switch isolation, Windows command-line construction, UTF-8 buffer decoding and timeout/cancellation drain-and-busy behavior in `lib/es.mjs`, and their regression cases, are adapted to JavaScript from `elis132/everything-mcp` 1.0.9, commit `22a60bd37b60de722db781c546383bc6d7bc8a66`: `src/everything_mcp/backend.py`, `src/everything_mcp/config.py`, and `tests/test_backend.py` / `tests/test_config.py`.

Source: https://github.com/elis132/everything-mcp/tree/22a60bd37b60de722db781c546383bc6d7bc8a66

The integration uses a single indexed-search tool, static Kiki root admission, canonical-path filtering, and an OS-owned named-pipe query lease rather than importing the MCP server or Python runtime. It requires Everything 1.5 and ES >=1.1.0.37, pins ES default argument mode, rejects disk-reading query functions, and fails on invalid UTF-8 rather than guessing an encoding. App activation retains the small JavaScript query owner while enabled so Kiki's ordinary 90-second tool-host idle recycling does not erase pending-query/busy state. The query lease coordinates this plugin's processes, not the Everything GUI or unrelated ES clients. Neither Everything nor ES binaries are redistributed in this package.

## everything-mcp — MIT License

Copyright (c) 2026 elis132

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
