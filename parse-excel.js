const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const filePath = path.join(process.cwd(), 'CTDC-Test-Execution.xlsx');

if (!fs.existsSync(filePath)) {
  console.error('File not found:', filePath);
  process.exit(1);
}

const workbook = XLSX.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log(JSON.stringify(data, null, 2));
