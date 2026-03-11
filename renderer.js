const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let connections = [];
let currentConnection = null;
let activeConnections = new Map(); // 存储活跃的连接 ID

// 加载连接配置
function loadConnections() {
  try {
    const configPath = path.join(__dirname, 'connections.json');
    if (fs.existsSync(configPath)) {
      connections = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (error) {
    console.error('加载连接配置失败:', error);
  }
}

// 保存连接配置
function saveConnections() {
  try {
    const configPath = path.join(__dirname, 'connections.json');
    fs.writeFileSync(configPath, JSON.stringify(connections, null, 2));
  } catch (error) {
    console.error('保存连接配置失败:', error);
  }
}

// 初始化树状结构
function initTree() {
  $('#connection-tree').jstree({
    'core': {
      'data': function (node, cb) {
        if (node.id === '#') {
          // 根节点：连接列表
          const treeData = connections.map(conn => ({
            id: `conn_${conn.id}`,
            text: conn.name,
            icon: 'jstree-folder',
            children: true,
            type: 'connection'
          }));
          cb(treeData);
        } else if (node.type === 'connection') {
          // 连接下的数据库
          const connId = node.id.replace('conn_', '');
          loadDatabases(connId, cb);
        } else if (node.type === 'database') {
          // 数据库下的表
          const connId = node.parent.replace('conn_', '');
          const dbName = node.text;
          loadTables(connId, dbName, cb);
        }
      }
    },
    'types': {
      'connection': { icon: 'jstree-folder' },
      'database': { icon: 'jstree-file' },
      'table': { icon: 'jstree-file' }
    },
    'plugins': ['types', 'contextmenu'],
    'contextmenu': {
      'items': function (node) {
        const items = {};
        if (node.type === 'database') {
          items.export = {
            label: '导出数据库',
            action: () => exportDatabase(node)
          };
        } else if (node.type === 'table') {
          items.export = {
            label: '导出数据表',
            action: () => exportTable(node)
          };
        }
        return items;
      }
    }
  }).on('before_open.jstree', function (e, data) {
    const node = data.node;
    if (node.type === 'connection') {
      const connId = node.id.replace('conn_', '');
      const config = connections.find(c => c.id === connId);
      if (config) {
        connectToDatabase(config);
      }
    }
  }).on('select_node.jstree', function (e, data) {
    const node = data.node;
    if (node.type === 'table') {
      const connId = node.parents.find(p => p.startsWith('conn_')).replace('conn_', '');
      const dbName = $('#connection-tree').jstree(true).get_node(node.parent).text;
      const tableName = node.text;
      loadTableData(connId, dbName, tableName);
    }
  });
}

// 连接到数据库
async function connectToDatabase(config) {
  try {
    const connectionId = await ipcRenderer.invoke('connect-ssh', config);
    activeConnections.set(config.id, connectionId);
    currentConnection = connectionId;
  } catch (error) {
    alert('连接失败: ' + error.message);
  }
}

// 加载数据库列表
async function loadDatabases(connId, callback) {
  const activeConnId = activeConnections.get(connId);
  if (!activeConnId) {
    callback([]);
    return;
  }

  try {
    const result = await ipcRenderer.invoke('get-databases', activeConnId);
    const treeData = result.map(db => ({
      id: `db_${db}`,
      text: db,
      icon: 'jstree-folder',
      children: true,
      type: 'database'
    }));
    callback(treeData);
  } catch (error) {
    console.error('加载数据库失败:', error);
    callback([]);
  }
}

// 加载表列表
async function loadTables(connId, dbName, callback) {
  const activeConnId = activeConnections.get(connId);
  if (!activeConnId) {
    callback([]);
    return;
  }

  try {
    const result = await ipcRenderer.invoke('get-tables', activeConnId, dbName);
    const treeData = result.map(table => ({
      id: `table_${table}`,
      text: table,
      icon: 'jstree-file',
      children: false,
      type: 'table'
    }));
    callback(treeData);
  } catch (error) {
    console.error('加载表失败:', error);
    callback([]);
  }
}

// 加载表数据
async function loadTableData(connId, dbName, tableName) {
  const activeConnId = activeConnections.get(connId);
  if (!activeConnId) return;

  try {
    const result = await ipcRenderer.invoke('get-table-data', activeConnId, dbName, tableName);
    displayTableData(result);
  } catch (error) {
    console.error('加载表数据失败:', error);
    $('#data-content').html('<p class="text-danger">加载数据失败</p>');
  }
}

// 显示表数据
function displayTableData(data) {
  if (!data || data.length === 0) {
    $('#data-content').html('<p class="text-muted">表为空</p>');
    return;
  }

  const columns = Object.keys(data[0]);
  let html = '<table class="table table-striped table-hover"><thead><tr>';
  columns.forEach(col => {
    html += `<th>${col}</th>`;
  });
  html += '</tr></thead><tbody>';

  data.forEach(row => {
    html += '<tr>';
    columns.forEach(col => {
      html += `<td>${row[col]}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  $('#data-content').html(html);
}

// 执行 SQL
async function executeSQL() {
  const sql = $('#sql-input').val().trim();
  if (!sql || !currentConnection) return;

  try {
    const result = await ipcRenderer.invoke('execute-sql', currentConnection, sql);
    if (result.length > 0) {
      displayTableData(result);
    } else {
      $('#data-content').html('<p class="text-success">SQL 执行成功</p>');
    }
  } catch (error) {
    $('#data-content').html(`<p class="text-danger">SQL 执行失败: ${error.message}</p>`);
  }
}

// 添加连接
function addConnection() {
  $('#connectionModal').modal('show');
}

// 保存连接
function saveConnection() {
  const config = {
    id: Date.now().toString(),
    name: $('#conn-name').val(),
    ssh: {
      host: $('#ssh-host').val(),
      port: parseInt($('#ssh-port').val()),
      username: $('#ssh-username').val(),
      password: $('#ssh-password').val()
    },
    mysql: {
      host: $('#mysql-host').val(),
      port: parseInt($('#mysql-port').val()),
      username: $('#mysql-username').val(),
      password: $('#mysql-password').val()
    }
  };

  connections.push(config);
  saveConnections();
  $('#connectionModal').modal('hide');
  $('#connection-tree').jstree(true).refresh();
}

// 导出数据库
async function exportDatabase(node) {
  const connId = node.id.replace('conn_', '');
  const activeConnId = activeConnections.get(connId);
  if (!activeConnId) return;

  const dbName = node.text;
  try {
    await ipcRenderer.invoke('export-database', activeConnId, dbName);
    alert('数据库导出成功');
  } catch (error) {
    alert('导出失败: ' + error.message);
  }
}

// 导出表
async function exportTable(node) {
  const connId = node.parents.find(p => p.startsWith('conn_')).replace('conn_', '');
  const activeConnId = activeConnections.get(connId);
  if (!activeConnId) return;

  const dbName = $('#connection-tree').jstree(true).get_node(node.parent).text;
  const tableName = node.text;
  try {
    await ipcRenderer.invoke('export-table', activeConnId, dbName, tableName);
    alert('数据表导出成功');
  } catch (error) {
    alert('导出失败: ' + error.message);
  }
}

// 初始化
$(document).ready(() => {
  loadConnections();
  initTree();
});