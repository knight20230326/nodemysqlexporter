#!/usr/bin/env node

const { Client } = require('ssh2');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 读取配置文件
function loadConfig() {
  const configPath = process.argv[2] || './config.json';
  
  if (!fs.existsSync(configPath)) {
    console.error('❌ 配置文件不存在:', configPath);
    console.log('用法: ./exporter [config.json]');
    console.log('');
    console.log('配置文件格式示例:');
    console.log(JSON.stringify({
      ssh: {
        host: "your-ssh-server.com",
        port: 22,
        username: "root",
        password: "your-password",
        // 或使用私钥: privateKeyPath: "/path/to/key"
      },
      mysql: {
        host: "127.0.0.1",
        port: 3306,
        user: "dbuser",
        password: "dbpass",
        database: "dbname"
      },
      output: "backup.sql"
    }, null, 2));
    process.exit(1);
  }
  
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

class MySQLSSHExporter {
  constructor(config) {
    this.sshConfig = config.ssh;
    this.dbConfig = config.mysql;
    this.outputFile = config.output || 'backup.sql';
    this.sshClient = new Client();
    this.totalRows = 0;
  }

  async export() {
    // 清空或创建输出文件
    fs.writeFileSync(this.outputFile, `-- MySQL Backup\n-- Database: ${this.dbConfig.database}\n-- Time: ${new Date().toISOString()}\n\nSET FOREIGN_KEY_CHECKS=0;\nSET NAMES utf8mb4;\n\n`);
    
    return new Promise((resolve, reject) => {
      this.sshClient.on('ready', async () => {
        try {
          console.log('✅ SSH连接成功');
          
          const stream = await this.createTunnel();
          const connection = await mysql.createConnection({
            ...this.dbConfig,
            stream: stream,
            multipleStatements: true
          });

          console.log('✅ MySQL连接成功');
          console.log('📦 开始导出...');
          
          await this.exportStructure(connection);
          await this.exportData(connection);
          await this.exportViews(connection);
          await this.exportProcedures(connection);
          await this.exportFunctions(connection);
          await this.exportTriggers(connection);

          // 添加结尾
          fs.appendFileSync(this.outputFile, '\nSET FOREIGN_KEY_CHECKS=1;\n');
          
          await connection.end();
          this.sshClient.end();
          
          const stats = fs.statSync(this.outputFile);
          console.log(`✅ 导出完成: ${this.outputFile}`);
          console.log(`📊 总行数: ${this.totalRows}`);
          console.log(`📏 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          
          resolve();
          
        } catch (err) {
          reject(err);
        }
      }).on('error', reject).connect(this.sshConfig);
    });
  }

  createTunnel() {
    return new Promise((resolve, reject) => {
      this.sshClient.forwardOut(
        '127.0.0.1', 0,
        this.dbConfig.host || '127.0.0.1',
        this.dbConfig.port || 3306,
        (err, stream) => {
          if (err) reject(err);
          else resolve(stream);
        }
      );
    });
  }

  async exportStructure(conn) {
    console.log('📋 导出表结构...');
    
    const [tables] = await conn.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
    `, [this.dbConfig.database]);

    for (const { TABLE_NAME } of tables) {
      const [[result]] = await conn.query(`SHOW CREATE TABLE \`${TABLE_NAME}\``);
      const sql = `\n-- ----------------------------\n-- Table: ${TABLE_NAME}\n-- ----------------------------\nDROP TABLE IF EXISTS \`${TABLE_NAME}\`;\n${result['Create Table']};\n`;
      fs.appendFileSync(this.outputFile, sql);
    }
  }

  async exportData(conn) {
    console.log('📊 导出数据...');
    
    const [tables] = await conn.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
    `, [this.dbConfig.database]);

    for (const { TABLE_NAME } of tables) {
      const [columns] = await conn.query(`
        SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      `, [this.dbConfig.database, TABLE_NAME]);

      // 流式分页查询
      let offset = 0;
      const batchSize = 1000;
      let firstBatch = true;

      while (true) {
        const [rows] = await conn.query(
          `SELECT * FROM \`${TABLE_NAME}\` LIMIT ? OFFSET ?`,
          [batchSize, offset]
        );
        
        if (rows.length === 0) break;
        
        if (firstBatch) {
          fs.appendFileSync(this.outputFile, `\n-- ----------------------------\n-- Data for ${TABLE_NAME}\n-- ----------------------------\n`);
          firstBatch = false;
        }

        const insert = this.buildInsertSql(TABLE_NAME, columns, rows);
        fs.appendFileSync(this.outputFile, insert + '\n');
        
        this.totalRows += rows.length;
        offset += rows.length;
        process.stdout.write(`\r  ${TABLE_NAME}: ${offset} rows`);
      }
      if (!firstBatch) console.log('');
    }
  }

  buildInsertSql(tableName, columns, rows) {
    const cols = columns.map(c => `\`${c.COLUMN_NAME}\``).join(', ');
    const vals = rows.map(row => {
      return '(' + columns.map(col => this.escapeValue(row[col.COLUMN_NAME], col.DATA_TYPE)).join(', ') + ')';
    }).join(',\n');
    return `INSERT INTO \`${tableName}\` (${cols}) VALUES\n${vals};`;
  }

  escapeValue(val, type) {
    if (val === null) return 'NULL';
    const t = type.toLowerCase();
    if (['int', 'bigint', 'decimal', 'float', 'double', 'tinyint', 'smallint', 'mediumint'].some(x => t.includes(x))) {
      return val;
    }
    if (t.includes('blob') || t.includes('binary')) {
      return `0x${Buffer.from(val).toString('hex')}`;
    }
    const s = String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return `'${s}'`;
  }

  async exportViews(conn) {
    console.log('👁️ 导出视图...');
    const [views] = await conn.query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = ?`, [this.dbConfig.database]);
    for (const { TABLE_NAME } of views) {
      const [[r]] = await conn.query(`SHOW CREATE VIEW \`${TABLE_NAME}\``);
      let sql = r['Create View'].replace(/CREATE ALGORITHM=\w+ DEFINER=`[^`]+`@`[^`]+` SQL SECURITY \w+ VIEW/, 'CREATE VIEW');
      fs.appendFileSync(this.outputFile, `\nDROP VIEW IF EXISTS \`${TABLE_NAME}\`;\n${sql};\n`);
    }
  }

  async exportProcedures(conn) {
    console.log('⚙️ 导出存储过程...');
    const [procs] = await conn.query(`SELECT ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'`, [this.dbConfig.database]);
    for (const { ROUTINE_NAME } of procs) {
      const [[r]] = await conn.query(`SHOW CREATE PROCEDURE \`${ROUTINE_NAME}\``);
      fs.appendFileSync(this.outputFile, `\nDROP PROCEDURE IF EXISTS \`${ROUTINE_NAME}\`;\nDELIMITER ;;\n${r['Create Procedure']};;\nDELIMITER ;\n`);
    }
  }

  async exportFunctions(conn) {
    console.log('🔧 导出函数...');
    const [funcs] = await conn.query(`SELECT ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION'`, [this.dbConfig.database]);
    for (const { ROUTINE_NAME } of funcs) {
      const [[r]] = await conn.query(`SHOW CREATE FUNCTION \`${ROUTINE_NAME}\``);
      fs.appendFileSync(this.outputFile, `\nDROP FUNCTION IF EXISTS \`${ROUTINE_NAME}\`;\nDELIMITER ;;\n${r['Create Function']};;\nDELIMITER ;\n`);
    }
  }

  async exportTriggers(conn) {
    console.log('⚡ 导出触发器...');
    const [triggers] = await conn.query(`SELECT TRIGGER_NAME FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [this.dbConfig.database]);
    for (const { TRIGGER_NAME } of triggers) {
      const [[r]] = await conn.query(`SHOW CREATE TRIGGER \`${TRIGGER_NAME}\``);
      fs.appendFileSync(this.outputFile, `\nDROP TRIGGER IF EXISTS \`${TRIGGER_NAME}\`;\nDELIMITER ;;\n${r['SQL Original Statement']};;\nDELIMITER ;\n`);
    }
  }
}

// 运行
(async () => {
  try {
    const config = loadConfig();
    const exporter = new MySQLSSHExporter(config);
    await exporter.export();
  } catch (err) {
    console.error('❌ 错误:', err.message);
    process.exit(1);
  }
})();