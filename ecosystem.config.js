module.exports = {
  apps: [{
    name: 'aninsohbeti',
    script: 'server.js',
    cwd: '/opt/web-projects/aninsohbeti',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 6000,
    },
    error_file: '/opt/web-projects/aninsohbeti/.logs/pm2-error.log',
    out_file: '/opt/web-projects/aninsohbeti/.logs/pm2-out.log',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    min_uptime: 10000,
    listen_timeout: 5000,
    kill_timeout: 10000,
    shutdown_with_message: true,
  }]
};
