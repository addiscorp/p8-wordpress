# p8 WordPress

WordPress in the browser. The page runs `php2.wasm` (PHP 8.4, wasm32-wasip1). WordPress talks to SQLite through the SQLite Database Integration plugin and PDO `pdo_sqlite`. The driver is Turso, compiled into p8. Nothing is mounted from MySQL.

The site is installed already and opens signed in as `admin`. Writes stay in this browser (IndexedDB) and survive reload. Reset clears that and restores the installed site. The password is `p8-demo-password`.

## Cloudflare

Worker name: `p8-wordpress`

Attach `p8-wordpress.addis.gg` in the Cloudflare dashboard. The domain is not in wrangler config.

Workers Builds, from the repository root, production branch `main`:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

`npx wrangler deploy` publishes the worker named `p8-wordpress`.

## License

[MIT](LICENSE)
