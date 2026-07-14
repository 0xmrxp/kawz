// PM2 process config for Lobre.
// Bun reads .env automatically from cwd (/opt/lobre/.env) — no dotenv required.

module.exports = {
  apps: [
    {
      name: 'lobre',
      script: 'src/backend/server.ts',
      interpreter: 'bun',
      interpreter_args: 'run',
      cwd: '/opt/lobre',
      instances: 1,
      autorestart: true,
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/var/log/lobre/out.log',
      error_file: '/var/log/lobre/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
