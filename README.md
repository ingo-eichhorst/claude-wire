# Claude Wire

A specialized network monitoring tool designed to intercept and log API requests from Claude Coder CLI. Beyond logging, this tool lays the groundwork for redirecting requests to alternative language models.

## Features

🔍 Captures all network traffic from Claude Coder, including HTTP, WebSocket, and SSE connections
📝 Logs complete request and response data without truncation
🔄 Handles streaming connections with special care to maintain functionality
🔀 Foundation for redirecting Claude Coder requests to alternative models (Mistral, Llama, etc.)
🛠️ Works with the obfuscated Claude Coder code without modifying it

## Installation

Clone this repository:

```bash
git clone https://github.com/ingo-eichhorst/claude-wire.git
cd claude-wire
```

There are no dependencies to install - the monitor uses only Node.js built-in modules.

## Quick Start

0. Find the location of claude-coder javascript file:
  - `npm root -g` 
  - apend: "/@anthropic-ai/claude-code/cli.mjs"
  - It gives you the path, like: /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.mjs

1. Find the location of claude wire:
  - `pwd`
  - It gives you the path, append index.js
  - Like: /Users/me/claude-wire/index.js

2. Navigate to the repo you want to investigate as usual

3. Start your Node.js application with the monitor:

```bash
node --import <location-of-claude-wire> <location-of-claude-coder>
# like: node --import /Users/me/claude-wire/index.js /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.mjs
```

4. From here on you can use claude-coder as usual

5. Check the generated logs in the `network-logs` directory:
   - `http-requests.log` - All HTTP/HTTPS traffic (You'll find most stuff here)
   - `websocket-messages.log` - All WebSocket communication
   - `tcp-connections.log` - Raw TCP/IP socket data

## How It Works

The monitor uses JavaScript's dynamic nature to monkey-patch Node.js's built-in networking modules:

- `http` and `https` modules for HTTP/HTTPS traffic
- `net` module for TCP connections
- Global `WebSocket` and other WebSocket implementations
- `fetch` API and `EventSource` for modern applications

All network activity is intercepted, logged, and then allowed to proceed normally.

## Limitations

- Large binary transfers may produce very large log files
- Some highly obfuscated applications might use unusual techniques to make network requests
- TLS monitoring is limited to the socket level due to ESM restrictions

## Contributing

Contributions are welcome! Please feel free to submit Issues or a Pull Request.

## License

This project is licensed under the MIT License.