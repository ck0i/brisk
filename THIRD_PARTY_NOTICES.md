# Third-party notices

This file covers Brisk's direct runtime dependencies at the versions pinned in `package.json` and installed by `bun.lock`. It intentionally does not reproduce the license of every transitive development/build package. Transitive packages retain their own notices in their source distributions.

## Direct runtime packages

| Package                        | Version | License                     | Project                                                                    |
| ------------------------------ | ------: | --------------------------- | -------------------------------------------------------------------------- |
| `@modelcontextprotocol/client` |   2.0.0 | Apache-2.0 / MIT transition | <https://github.com/modelcontextprotocol/typescript-sdk>                   |
| `@oh-my-pi/hashline`           |  17.2.6 | MIT                         | <https://github.com/can1357/oh-my-pi/tree/v17.2.6/packages/hashline>       |
| `@oh-my-pi/pi-ai`              |  17.2.6 | MIT                         | <https://github.com/can1357/oh-my-pi/tree/v17.2.6/packages/ai>             |
| `@oh-my-pi/pi-catalog`         |  17.2.6 | MIT                         | <https://github.com/can1357/oh-my-pi/tree/v17.2.6/packages/catalog>        |
| `@oh-my-pi/snapcompact`        |  17.2.6 | MIT                         | <https://github.com/can1357/oh-my-pi/tree/v17.2.6/packages/snapcompact>    |
| `@opentui/core`                |   0.5.0 | MIT                         | <https://github.com/anomalyco/opentui/tree/v0.5.0/packages/core>           |
| `@opentui/solid`               |   0.5.0 | MIT                         | <https://github.com/anomalyco/opentui/tree/v0.5.0/packages/solid>          |
| `diff`                         |   8.0.3 | BSD-3-Clause                | <https://github.com/kpdecker/jsdiff>                                       |
| `jsonc-parser`                 |   3.3.1 | MIT                         | <https://github.com/microsoft/node-jsonc-parser>                           |
| `solid-js`                     |  1.9.12 | MIT                         | <https://github.com/solidjs/solid>                                         |
| `web-tree-sitter`              | 0.25.10 | MIT                         | <https://github.com/tree-sitter/tree-sitter/tree/v0.25.10/lib/binding_web> |
| `zod`                          |   4.4.3 | MIT                         | <https://github.com/colinhacks/zod>                                        |

Versions and license information above are taken from installed package metadata and bundled license files. The copyright notices below are retained from installed license files or the identified upstream release license where a package omitted a license file.

## Model Context Protocol client

Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.

The project is transitioning from MIT to Apache-2.0; contributions retain the applicable original license. The complete upstream transition notice and license texts ship in the installed package. Standalone Brisk releases include them at `licenses/@modelcontextprotocol-client-LICENSE`.

## MIT attributions

### oh-my-pi packages

Applies to `@oh-my-pi/hashline`, `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, and `@oh-my-pi/snapcompact`.

Copyright (c) 2025 Mario Zechner  
Copyright (c) 2025-2026 Can Bölük

### OpenTUI packages

Applies to `@opentui/core` and `@opentui/solid`.

Copyright (c) 2025 opentui

### jsonc-parser

Copyright (c) Microsoft

### solid-js

Copyright (c) 2016-2025 Ryan Carniato

### web-tree-sitter

Copyright (c) 2018-2024 Max Brunsfeld

### zod

Copyright (c) 2025 Colin McDonnell

### MIT license text

The following terms apply to each MIT-licensed package listed above:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## diff 8.0.3, BSD-3-Clause

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>  
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Brisk

Brisk itself is distributed under the MIT license in [LICENSE](LICENSE). This notice is informational and does not replace the complete source distributions or their license files.
