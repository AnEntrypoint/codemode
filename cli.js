#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--agent')) {
  import('./agent.js');
} else {
  import('./index.js');
}
