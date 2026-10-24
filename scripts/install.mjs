process.argv.splice(2, 0, 'install')
await import('../cli.mjs')
