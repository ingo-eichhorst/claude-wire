// full-logging-network-monitor.mjs - With all truncation removed
// Import required modules
import fs from 'fs';
import path from 'path';
import util from 'util';
import http from 'http';
import https from 'https';
import net from 'net';
import { fileURLToPath } from 'url';

// Get current directory in ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a log directory if it doesn't exist
const logDir = path.join(process.cwd(), 'network-logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Create log files
const httpLogPath = path.join(logDir, 'http-requests.log');
const wsLogPath = path.join(logDir, 'websocket-messages.log');
const tcpLogPath = path.join(logDir, 'tcp-connections.log');

// Create write streams
const httpLogStream = fs.createWriteStream(httpLogPath, { flags: 'a' });
const wsLogStream = fs.createWriteStream(wsLogPath, { flags: 'a' });
const tcpLogStream = fs.createWriteStream(tcpLogPath, { flags: 'a' });

// Helper to log with timestamp
function logWithTimestamp(stream, message) {
  const timestamp = new Date().toISOString();
  stream.write(`[${timestamp}] ${message}\n`);
}

// Log startup
console.log(`Network monitoring active. Logs stored in ${logDir}`);
logWithTimestamp(httpLogStream, '=== HTTP MONITORING STARTED ===');
logWithTimestamp(wsLogStream, '=== WEBSOCKET MONITORING STARTED ===');
logWithTimestamp(tcpLogStream, '=== TCP MONITORING STARTED ===');

// ==========================================
// Monitor HTTP/HTTPS requests
// ==========================================

// Track request IDs
let requestCounter = 0;

// Helper function to check if a connection is likely to be streaming
function isStreamingConnection(headers, url) {
  if (!headers && !url) return false;
  
  // Check response headers
  if (headers) {
    // Check content type for streaming indicators
    const contentType = headers['content-type'] || '';
    if (contentType.includes('text/event-stream') || 
        contentType.includes('stream')) {
      return true;
    }
    
    // Check for transfer encoding chunked (common for streams)
    if (headers['transfer-encoding'] === 'chunked') {
      return true;
    }
  }
  
  // Check request URL for common streaming endpoints
  if (url) {
    const urlStr = url.toString().toLowerCase();
    if (urlStr.includes('stream') || 
        urlStr.includes('anthropic.com') ||
        urlStr.includes('claude') || 
        urlStr.includes('sse') || 
        urlStr.includes('events')) {
      return true;
    }
  }
  
  return false;
}

// Monkey patch the http.request and https.request methods
function patchHttpModule(originalRequest, protocol) {
  return function(url, options, callback) {
    const requestId = ++requestCounter;
    
    // Handle the different forms of the function signature
    let parsedUrl;
    let callbackFunc;
    
    if (typeof url === 'string' || url instanceof URL) {
      parsedUrl = url;
      callbackFunc = typeof options === 'function' ? options : callback;
    } else {
      parsedUrl = url.hostname || url.host || 'unknown-host';
      options = url;
      callbackFunc = callback;
    }

    // Extract request details
    const urlStr = typeof parsedUrl === 'string' ? parsedUrl : parsedUrl.toString();
    const method = options.method || 'GET';
    const headers = options.headers || {};
    
    // Check if this is likely to be a streaming connection
    const isStreaming = isStreamingConnection(headers, urlStr);
    
    // Log the request
    try {
      const headersJson = JSON.stringify(headers);
      
      logWithTimestamp(
        httpLogStream, 
        `REQUEST [${requestId}] ${protocol} ${method} ${urlStr} ${headersJson}${isStreaming ? ' [STREAMING]' : ''}`
      );
    } catch (error) {
      logWithTimestamp(httpLogStream, `ERROR logging request: ${error.message}`);
    }

    // Call the original request method
    const req = originalRequest.apply(this, arguments);
    
    // If there's a body to be sent, log it
    const originalWrite = req.write;
    req.write = function(chunk) {
      try {
        if (chunk) {
          const body = chunk.toString();
          logWithTimestamp(
            httpLogStream, 
            `REQUEST BODY [${requestId}] ${body}`
          );
        }
      } catch (error) {
        logWithTimestamp(httpLogStream, `ERROR logging request body: ${error.message}`);
      }
      return originalWrite.apply(this, arguments);
    };
    
    // Monitor the response
    req.on('response', (res) => {
      try {
        // Check again if this is a streaming response
        const isStreamingResponse = isStreamingConnection(res.headers, urlStr);
        
        logWithTimestamp(
          httpLogStream, 
          `RESPONSE [${requestId}] Status: ${res.statusCode} Headers: ${JSON.stringify(res.headers || {})}${isStreamingResponse ? ' [STREAMING]' : ''}`
        );
        
        // For streaming responses, don't try to capture the whole body
        // Instead, just log that it's a streaming response
        if (isStreamingResponse) {
          logWithTimestamp(httpLogStream, `RESPONSE BODY [${requestId}] [Streaming content - logging chunks individually]`);
          
          // Use a passthrough approach instead of collecting the whole body
          const originalEmit = res.emit;
          res.emit = function(event, ...args) {
            if (event === 'data') {
              try {
                const chunk = args[0];
                const chunkData = chunk.toString();
                logWithTimestamp(httpLogStream, `RESPONSE STREAM CHUNK [${requestId}] ${chunkData}`);
              } catch (error) {
                logWithTimestamp(httpLogStream, `ERROR logging stream chunk: ${error.message}`);
              }
            }
            return originalEmit.apply(this, [event, ...args]);
          };
        } else {
          // For non-streaming responses, we can safely capture the whole body
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          
          res.on('end', () => {
            if (body) {
              logWithTimestamp(
                httpLogStream, 
                `RESPONSE BODY [${requestId}] ${body}`
              );
            }
          });
        }
      } catch (error) {
        logWithTimestamp(httpLogStream, `ERROR logging response: ${error.message}`);
      }
    });
    
    // Monitor request errors
    req.on('error', (error) => {
      logWithTimestamp(httpLogStream, `ERROR [${requestId}] ${error.message}`);
    });
    
    return req;
  };
}

// Apply patches
http.request = patchHttpModule(http.request, 'HTTP');
https.request = patchHttpModule(https.request, 'HTTPS');

// Patch http.get and https.get which use request internally
http.get = function() {
  const req = http.request.apply(this, arguments);
  req.end();
  return req;
};

https.get = function() {
  const req = https.request.apply(this, arguments);
  req.end();
  return req;
};

// ==========================================
// Detect and patch EventSource/SSE
// ==========================================

try {
  // Try to patch EventSource if it exists
  if (globalThis.EventSource) {
    const OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = function(url, options) {
      logWithTimestamp(httpLogStream, `EventSource CONNECTION: ${url} ${options ? JSON.stringify(options) : ''}`);
      
      const eventSource = new OriginalEventSource(url, options);
      
      // Monitor events without interfering
      const originalAddEventListener = eventSource.addEventListener;
      eventSource.addEventListener = function(type, listener, options) {
        if (type === 'message') {
          const originalListener = listener;
          // Create a wrapper to log messages but not interfere with the event
          const newListener = function(event) {
            try {
              logWithTimestamp(httpLogStream, `EventSource MESSAGE: ${event.data}`);
            } catch (error) {
              logWithTimestamp(httpLogStream, `ERROR logging EventSource message: ${error.message}`);
            }
            // Call the original listener
            return originalListener.apply(this, arguments);
          };
          
          // Replace the listener
          return originalAddEventListener.call(this, type, newListener, options);
        }
        
        if (type === 'open' || type === 'error' || type === 'close') {
          logWithTimestamp(httpLogStream, `EventSource added listener for: ${type}`);
        }
        
        return originalAddEventListener.apply(this, arguments);
      };
      
      return eventSource;
    };
    console.log('Monitoring EventSource connections');
  }
} catch (error) {
  console.log('EventSource not available or could not be patched:', error.message);
}

// Try to patch fetch API which might be used for streaming
try {
  if (globalThis.fetch) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function(...args) {
      const url = args[0]?.url || args[0];
      const options = args[1] || {};
      
      // Log the fetch call
      logWithTimestamp(httpLogStream, `FETCH: ${url} ${options ? JSON.stringify(options) : ''}`);
      
      // Check if this is likely to be a streaming request
      const isStreaming = 
        options.headers?.Accept === 'text/event-stream' || 
        String(url).includes('anthropic.com') || 
        String(url).includes('claude') ||
        options.headers?.['content-type']?.includes('stream');
      
      if (isStreaming) {
        logWithTimestamp(httpLogStream, `FETCH STREAMING detected - special handling for streams`);
      }
      
      // Call original fetch
      const response = await originalFetch.apply(this, args);
      
      // For streaming responses, we need special handling
      if (isStreaming || response.headers.get('content-type')?.includes('event-stream')) {
        logWithTimestamp(httpLogStream, `FETCH RESPONSE: ${response.status} ${response.statusText} [Streaming]`);
        
        // We want to log the stream data, but we can't consume it
        // So we'll return a new Response that logs as it streams
        const originalBody = response.body;
        if (originalBody) {
          try {
            // Create a TransformStream to log chunks while passing them through
            const { readable, writable } = new TransformStream({
              transform(chunk, controller) {
                try {
                  const textChunk = new TextDecoder().decode(chunk);
                  logWithTimestamp(httpLogStream, `FETCH STREAM DATA: ${textChunk}`);
                } catch (error) {
                  logWithTimestamp(httpLogStream, `ERROR decoding stream chunk: ${error.message}`);
                }
                controller.enqueue(chunk);
              }
            });
            
            // Pipe through our transform
            originalBody.pipeTo(writable);
            
            // Return a new response with our transformed readable stream
            return new Response(readable, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          } catch (error) {
            logWithTimestamp(httpLogStream, `ERROR setting up stream logging: ${error.message}`);
            return response;
          }
        }
        return response;
      }
      
      // For regular responses, we can log more details
      logWithTimestamp(httpLogStream, `FETCH RESPONSE: ${response.status} ${response.statusText}`);
      
      // Only try to log body for JSON or text responses
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('json') || contentType.includes('text')) {
        try {
          // Clone the response to avoid consuming the original
          const clone = response.clone();
          const body = await clone.text();
          logWithTimestamp(httpLogStream, `FETCH RESPONSE BODY: ${body}`);
        } catch (error) {
          logWithTimestamp(httpLogStream, `ERROR logging fetch response body: ${error.message}`);
        }
      }
      
      return response;
    };
    console.log('Monitoring fetch API');
  }
} catch (error) {
  console.log('Fetch API not available or could not be patched:', error.message);
}

// ==========================================
// Monitor WebSocket communications
// ==========================================

// We need to handle multiple WebSocket implementations
// First, let's try the native WebSocket if it exists
try {
  // This is for newer Node.js versions with built-in WebSocket
  const WebSocket = globalThis.WebSocket;
  if (WebSocket) {
    const originalWebSocket = WebSocket;
    globalThis.WebSocket = function(url, protocols) {
      logWithTimestamp(wsLogStream, `WS CONNECTION: ${url} ${protocols ? JSON.stringify(protocols) : ''}`);
      
      const ws = new originalWebSocket(url, protocols);
      
      const originalSend = ws.send;
      ws.send = function(data) {
        try {
          const logData = typeof data === 'string' ? data : 
                          (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) ? 
                          `<binary data: ${data.byteLength || data.buffer.byteLength} bytes>\n${new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer).toString()}` : 
                          String(data);
          
          logWithTimestamp(
            wsLogStream, 
            `WS SEND: ${logData}`
          );
        } catch (error) {
          logWithTimestamp(wsLogStream, `ERROR logging WebSocket send: ${error.message}`);
        }
        return originalSend.apply(this, arguments);
      };
      
      ws.addEventListener('message', (event) => {
        try {
          const logData = typeof event.data === 'string' ? event.data : 
                          (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) ? 
                          `<binary data: ${event.data.byteLength || event.data.buffer.byteLength} bytes>\n${new Uint8Array(event.data instanceof ArrayBuffer ? event.data : event.data.buffer).toString()}` : 
                          String(event.data);
          
          logWithTimestamp(
            wsLogStream, 
            `WS RECEIVE: ${logData}`
          );
        } catch (error) {
          logWithTimestamp(wsLogStream, `ERROR logging WebSocket message: ${error.message}`);
        }
      });
      
      ws.addEventListener('open', () => {
        logWithTimestamp(wsLogStream, `WS OPEN: ${url}`);
      });
      
      ws.addEventListener('close', (event) => {
        logWithTimestamp(wsLogStream, `WS CLOSE: ${url} Code: ${event.code} Reason: ${event.reason}`);
      });
      
      ws.addEventListener('error', (error) => {
        logWithTimestamp(wsLogStream, `WS ERROR: ${url} ${error}`);
      });
      
      return ws;
    };
    console.log('Monitoring built-in WebSocket');
  }
} catch (error) {
  console.log('No built-in WebSocket found:', error.message);
}

// For ESM monitoring, we need a different approach than CommonJS
// We'll use import.meta.resolve for Node.js >= 16
if (import.meta.resolve) {
  try {
    const originalImportMetaResolve = import.meta.resolve;
    import.meta.resolve = function(specifier, ...args) {
      const resolved = originalImportMetaResolve.call(this, specifier, ...args);
      
      if (specifier === 'ws') {
        // We can't monkey patch the module directly in ESM, but we can log the usage
        logWithTimestamp(wsLogStream, `WS MODULE IMPORTED: ${resolved}`);
        console.log('WebSocket module "ws" imported - monitoring via globals only');
      }
      
      return resolved;
    };
    console.log('ESM import monitoring enabled');
  } catch (error) {
    console.log('Error setting up ESM import monitoring:', error.message);
  }
}

// Add a global helper for monitoring WebSockets
globalThis.__monitorWebSocket = function(ws, url) {
  if (!ws.__monitored) {
    ws.__monitored = true;
    logWithTimestamp(wsLogStream, `WS MONITORING ATTACHED: ${url || 'unknown'}`);
    
    // Patch methods without breaking functionality
    if (ws.send && typeof ws.send === 'function') {
      const originalSend = ws.send;
      ws.send = function(data) {
        try {
          const logData = typeof data === 'string' ? data : 
                        (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) ? 
                        `<binary data: ${data.byteLength || data.buffer.byteLength} bytes>\n${new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer).toString()}` : 
                        String(data);
          
          logWithTimestamp(wsLogStream, `WS SEND: ${logData}`);
        } catch (error) {
          logWithTimestamp(wsLogStream, `ERROR logging WS send: ${error.message}`);
        }
        return originalSend.apply(this, arguments);
      };
    }
    
    // Add listeners if addEventListener is available
    if (ws.addEventListener && typeof ws.addEventListener === 'function') {
      ws.addEventListener('message', (event) => {
        try {
          const logData = typeof event.data === 'string' ? event.data : 
                        (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) ? 
                        `<binary data: ${event.data.byteLength || event.data.buffer.byteLength} bytes>\n${new Uint8Array(event.data instanceof ArrayBuffer ? event.data : event.data.buffer).toString()}` : 
                        String(event.data);
          
          logWithTimestamp(wsLogStream, `WS RECEIVE: ${logData}`);
        } catch (error) {
          logWithTimestamp(wsLogStream, `ERROR logging WS message: ${error.message}`);
        }
      });
    }
    // If on is available, use that instead
    else if (ws.on && typeof ws.on === 'function') {
      ws.on('message', (data) => {
        try {
          const logData = typeof data === 'string' ? data : 
                        (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) ? 
                        `<binary data: ${data.byteLength || data.buffer.byteLength} bytes>\n${new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer).toString()}` : 
                        String(data);
          
          logWithTimestamp(wsLogStream, `WS RECEIVE: ${logData}`);
        } catch (error) {
          logWithTimestamp(wsLogStream, `ERROR logging WS message: ${error.message}`);
        }
      });
    }
  }
  return ws;
};

// ==========================================
// Monitor TCP/Socket connections 
// ==========================================

// Monkey patch the net.Socket.connect methods
// This works in ESM since we're patching the prototype methods
const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function() {
  try {
    // Extract connection info
    const options = arguments[0];
    const host = (typeof options === 'object') ? (options.host || 'unknown') : arguments[1] || 'unknown';
    const port = (typeof options === 'object') ? (options.port || 'unknown') : arguments[0] || 'unknown';
    
    // Check if this is likely to be Anthropic or another sensitive connection
    const isSensitiveConnection = 
      (typeof host === 'string' && (
        host.includes('anthropic') || 
        host.includes('claude')));
    
    logWithTimestamp(tcpLogStream, `SOCKET CONNECT: ${host}:${port}${isSensitiveConnection ? ' [SENSITIVE - MINIMAL MONITORING]' : ''}`);
    
    // Set up data logging
    if (!this._monitoredForData) {
      this._monitoredForData = true;
      
      // For sensitive connections, we'll only log connection events, not data
      if (!isSensitiveConnection) {
        this.on('data', (data) => {
          try {
            const hexData = data.toString('hex');
            // Log full hex representation
            logWithTimestamp(tcpLogStream, `SOCKET DATA RECEIVED HEX: ${host}:${port} Data: ${hexData}`);
            
            // Also try to log as string for better readability
            try {
              const strData = data.toString('utf8');
              logWithTimestamp(tcpLogStream, `SOCKET DATA RECEIVED TEXT: ${host}:${port} Data: ${strData}`);
            } catch (textError) {
              // If it can't be converted to text, just log the error
              logWithTimestamp(tcpLogStream, `SOCKET DATA RECEIVED TEXT ERROR: ${textError.message}`);
            }
          } catch (error) {
            logWithTimestamp(tcpLogStream, `ERROR logging Socket data: ${error.message}`);
          }
        });
        
        // Patch the write method to log outgoing data
        const originalWrite = this.write;
        this.write = function(data) {
          try {
            if (data) {
              // Log full hex representation
              const hexData = Buffer.isBuffer(data) ? data.toString('hex') : Buffer.from(String(data)).toString('hex');
              logWithTimestamp(tcpLogStream, `SOCKET DATA SENT HEX: ${host}:${port} Data: ${hexData}`);
              
              // Also try to log as string for better readability
              try {
                const strData = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
                logWithTimestamp(tcpLogStream, `SOCKET DATA SENT TEXT: ${host}:${port} Data: ${strData}`);
              } catch (textError) {
                // If it can't be converted to text, just log the error
                logWithTimestamp(tcpLogStream, `SOCKET DATA SENT TEXT ERROR: ${textError.message}`);
              }
            }
          } catch (error) {
            logWithTimestamp(tcpLogStream, `ERROR logging Socket write: ${error.message}`);
          }
          return originalWrite.apply(this, arguments);
        };
      } else {
        logWithTimestamp(tcpLogStream, `SOCKET DATA LOGGING DISABLED for sensitive connection: ${host}:${port}`);
      }
      
      // Monitor connection events for all connections
      this.on('connect', () => {
        logWithTimestamp(tcpLogStream, `SOCKET CONNECTED: ${host}:${port}`);
      });
      
      this.on('close', (hadError) => {
        logWithTimestamp(tcpLogStream, `SOCKET CLOSED: ${host}:${port} Error: ${hadError}`);
      });
      
      this.on('error', (error) => {
        logWithTimestamp(tcpLogStream, `SOCKET ERROR: ${host}:${port} ${error.message}`);
      });
    }
  } catch (error) {
    logWithTimestamp(tcpLogStream, `ERROR setting up Socket monitoring: ${error.message}`);
  }
  
  return originalSocketConnect.apply(this, arguments);
};

// Since createConnection uses Socket internally, this should work
const originalCreateConnection = net.createConnection;
net.createConnection = function() {
  const socket = originalCreateConnection.apply(this, arguments);
  return socket;
};

// For TLS, we'll use a different approach since we can't modify the module
console.log('Note: TLS connections will be captured at the Socket level');

// ==========================================
// Cleanup and error handling
// ==========================================

// Register process termination handlers
process.on('exit', () => {
  logWithTimestamp(httpLogStream, '=== HTTP MONITORING STOPPED ===');
  logWithTimestamp(wsLogStream, '=== WEBSOCKET MONITORING STOPPED ===');
  logWithTimestamp(tcpLogStream, '=== TCP MONITORING STOPPED ===');
  
  // Close streams
  httpLogStream.end();
  wsLogStream.end();
  tcpLogStream.end();
});

// Handle uncaught exceptions to ensure we close logs properly
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  logWithTimestamp(httpLogStream, `UNCAUGHT EXCEPTION: ${error.message}`);
  logWithTimestamp(wsLogStream, `UNCAUGHT EXCEPTION: ${error.message}`);
  logWithTimestamp(tcpLogStream, `UNCAUGHT EXCEPTION: ${error.message}`);
  
  // Close streams
  httpLogStream.end();
  wsLogStream.end();
  tcpLogStream.end();
  
  process.exit(1);
});

console.log('Network monitoring initialized with FULL logging (no truncation).');
