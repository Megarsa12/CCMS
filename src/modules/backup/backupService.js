'use strict';

const { getConnection } = require('../../config/db');

const BACKUP_FORMAT = 'ccms-mysql-backup';
const BACKUP_VERSION = 1;

function quoteIdentifier(identifier) {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

async function getTables(connection) {
  const [tables] = await connection.execute(
    `SELECT TABLE_NAME AS tableName
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`
  );
  return tables.map(({ tableName }) => tableName);
}

async function getColumns(connection, tableName) {
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME AS columnName, EXTRA AS extra
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [tableName]
  );
  return columns;
}

async function createBackup() {
  const connection = await getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction({ consistentSnapshot: true, readOnly: true });

    const tables = {};
    for (const tableName of await getTables(connection)) {
      const [rows] = await connection.query(`SELECT * FROM ${quoteIdentifier(tableName)}`);
      tables[tableName] = rows;
    }

    await connection.commit();
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables,
    };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function restoreBackup(backup) {
  if (
    !backup
    || backup.format !== BACKUP_FORMAT
    || backup.version !== BACKUP_VERSION
    || !backup.tables
    || typeof backup.tables !== 'object'
    || Array.isArray(backup.tables)
  ) {
    const err = new Error('The selected file is not a supported CCMS database backup.');
    err.statusCode = 400;
    throw err;
  }

  const connection = await getConnection();
  let transactionStarted = false;
  let foreignKeyChecksDisabled = false;

  try {
    const tableNames = await getTables(connection);
    const backupTableNames = Object.keys(backup.tables).sort();
    if (JSON.stringify(backupTableNames) !== JSON.stringify([...tableNames].sort())) {
      const err = new Error('The backup tables do not match this database schema.');
      err.statusCode = 400;
      throw err;
    }

    const columnsByTable = new Map();
    for (const tableName of tableNames) {
      const columns = await getColumns(connection, tableName);
      const expectedColumns = columns.map(({ columnName }) => columnName).sort();
      const rows = backup.tables[tableName];
      if (!Array.isArray(rows)) {
        const err = new Error(`Backup data for table "${tableName}" is invalid.`);
        err.statusCode = 400;
        throw err;
      }

      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          const err = new Error(`Backup data for table "${tableName}" is invalid.`);
          err.statusCode = 400;
          throw err;
        }
        const rowColumns = Object.keys(row).sort();
        if (JSON.stringify(rowColumns) !== JSON.stringify(expectedColumns)) {
          const err = new Error(`Backup columns for table "${tableName}" do not match this database schema.`);
          err.statusCode = 400;
          throw err;
        }
      }
      columnsByTable.set(tableName, columns);
    }

    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    foreignKeyChecksDisabled = true;
    await connection.beginTransaction();
    transactionStarted = true;

    for (const tableName of tableNames) {
      await connection.query(`DELETE FROM ${quoteIdentifier(tableName)}`);
    }

    for (const tableName of tableNames) {
      const insertColumns = columnsByTable.get(tableName)
        .filter(({ extra }) => !extra.toLowerCase().includes('generated'))
        .map(({ columnName }) => columnName);
      if (insertColumns.length === 0) continue;

      const columnSql = insertColumns.map(quoteIdentifier).join(', ');
      const placeholders = insertColumns.map(() => '?').join(', ');
      for (const row of backup.tables[tableName]) {
        const values = insertColumns.map(columnName => row[columnName]);
        await connection.execute(
          `INSERT INTO ${quoteIdentifier(tableName)} (${columnSql}) VALUES (${placeholders})`,
          values
        );
      }
    }

    await connection.commit();
    transactionStarted = false;
  } catch (err) {
    if (transactionStarted) await connection.rollback();
    throw err;
  } finally {
    if (foreignKeyChecksDisabled) {
      try {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
      } catch (err) {
        connection.release();
        throw err;
      }
    }
    connection.release();
  }
}

module.exports = { createBackup, restoreBackup };
