const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');
const mysql = require('mysql2/promise');

let mainWindow;
let connections = new Map(); // 存储活跃连接

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  });

  mainWindow.loadFile('index.html');

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// SSH 连接和 MySQL 连接
ipcMain.handle('connect-ssh', async (event, config) => {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      // SSH 连接成功，现在建立 MySQL 连接通过 SSH 隧道
      conn.forwardOut('127.0.0.1', 0, config.mysql.host, config.mysql.port, (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }

        const dbConfig = {
          host: '127.0.0.1',
          port: 0, // 使用动态端口
          user: config.mysql.username,
          password: config.mysql.password,
          database: config.mysql.database || null,
          stream: stream
        };

        mysql.createConnection(dbConfig).then(dbConn => {
          const connectionId = Date.now().toString();
          connections.set(connectionId, { ssh: conn, db: dbConn });
          resolve(connectionId);
        }).catch(err => {
          conn.end();
          reject(err);
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect({
      host: config.ssh.host,
      port: config.ssh.port,
      username: config.ssh.username,
      password: config.ssh.password
    });
  });
});

// 获取数据库列表
ipcMain.handle('get-databases', async (event, connectionId) => {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error('连接不存在');

  const [rows] = await conn.db.execute('SHOW DATABASES');
  return rows.map(row => row.Database);
});

// 获取表列表
ipcMain.handle('get-tables', async (event, connectionId, database) => {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error('连接不存在');

  await conn.db.execute(`USE \`${database}\``);
  const [rows] = await conn.db.execute('SHOW TABLES');
  const key = Object.keys(rows[0])[0];
  return rows.map(row => row[key]);
});

// 获取表数据
ipcMain.handle('get-table-data', async (event, connectionId, database, table) => {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error('连接不存在');

  await conn.db.execute(`USE \`${database}\``);
  const [rows] = await conn.db.execute(`SELECT * FROM \`${table}\` LIMIT 1000`);
  return rows;
});

// 执行 SQL
ipcMain.handle('execute-sql', async (event, connectionId, sql) => {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error('连接不存在');

  const [rows] = await conn.db.execute(sql);
  return rows;
});

// 导出数据库
ipcMain.handle('export-database', async (event, connectionId, database) => {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error('连接不存在');

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '选择导出位置',
    defaultPath: `${database}.sql`,
    filters: [{ name: 'SQL Files', extensions: ['sql'] }]
  });

  if (!result.canceled) {
    // 实现导出逻辑（类似原 exporter.js）
    const tables = await getTables(conn.db, database);
    let sql = '';

    for (const table of tables) {
      const createTableSQL = await getCreateTableSQL(conn.db, database, table);
      sql += createTableSQL + ';\n\n';

      const data = await getTableData(conn.db, database, table);
      if (data.length > 0) {
        const insertSQL = generateInsertSQL(table, data);
        sql += insertSQL + ';\n\n';
      }
    }

    fs.writeFileSync(result.filePath, sql);
  }
});

// 导出表
ipcMain.handle('export-table', async (event, connectionId, database, table) => {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error('连接不存在');

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '选择导出位置',
    defaultPath: `${table}.sql`,
    filters: [{ name: 'SQL Files', extensions: ['sql'] }]
  });

  if (!result.canceled) {
    const createTableSQL = await getCreateTableSQL(conn.db, database, table);
    const data = await getTableData(conn.db, database, table);
    let sql = createTableSQL + ';\n\n';

    if (data.length > 0) {
      sql += generateInsertSQL(table, data) + ';\n\n';
    }

    fs.writeFileSync(result.filePath, sql);
  }
});

// 辅助函数
async function getTables(db, database) {
  await db.execute(`USE \`${database}\``);
  const [rows] = await db.execute('SHOW TABLES');
  const key = Object.keys(rows[0])[0];
  return rows.map(row => row[key]);
}

async function getCreateTableSQL(db, database, table) {
  const [rows] = await db.execute(`SHOW CREATE TABLE \`${database}\`.\`${table}\``);
  return rows[0]['Create Table'];
}

async function getTableData(db, database, table) {
  const [rows] = await db.execute(`SELECT * FROM \`${database}\`.\`${table}\``);
  return rows;
}

function generateInsertSQL(table, data) {
  if (data.length === 0) return '';

  const columns = Object.keys(data[0]);
  const values = data.map(row => {
    return '(' + columns.map(col => {
      const value = row[col];
      if (value === null) return 'NULL';
      if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
      return value;
    }).join(', ') + ')';
  }).join(',\n');

  return `INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES\n${values};`;
}