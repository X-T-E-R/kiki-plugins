# Third-party notices

The ES query parser, switch isolation, Windows command-line construction, UTF-8 buffer decoding and their regression cases are adapted to JavaScript from `elis132/everything-mcp` 1.0.9, commit `22a60bd37b60de722db781c546383bc6d7bc8a66`: `src/everything_mcp/backend.py`, `src/everything_mcp/config.py`, and `tests/test_backend.py` / `tests/test_config.py`.

Source: https://github.com/elis132/everything-mcp/tree/22a60bd37b60de722db781c546383bc6d7bc8a66

The plugin uses Everything 1.5 and ES >=1.1.0.37 without importing the MCP server or Python runtime. It uses Kiki root admission, filters canonical paths, pins ES default argument mode, rejects disk-reading query functions, and decodes output as UTF-8. Each search uses a separate official ES client process. Neither Everything nor ES binaries are redistributed in this package.

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
