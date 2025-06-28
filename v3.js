const express = require('express');
const mqtt = require('mqtt');

const app = express();
const PORT = 3000;

const MQTT_HOST = 'lesvr.suntcn.com';
const MQTT_PORT = 1886;
const MQTT_USER = 'appuser';
const MQTT_PASSWORD = 'app666';
const DEVICE_ID = 'H250326002';
const USER_ID = '123456';
const clientId = `android-${USER_ID}-${Date.now()}`;

const workModes = [
  'Uninterruptible Power Mode (UPS)',
  'Save Money Mode',
  'Sell Mode',
  'Smart Meter Mode',
  'WIFI CT Mode',
  'MESH CT Mode'
];

const batteryModes = [
  'User Defined',
  'Special Battery Pack',
  'No Battery'
];

// Cache for latest and historical data
let latestDeviceData = null;
let latestBatteryCellData = null;
const historicalData = { deviceData: [], batteryCellData: [] };

// MQTT client setup
const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  clientId,
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  clean: true
});

// Calculate CRC16 Modbus checksum
function crc16Modbus(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return [crc & 0xFF, crc >> 8];
}

// Create Modbus read command
function getReadHexStr(startAddr, count) {
  const cmd = [
    0x01,
    0x03,
    (startAddr >> 8) & 0xFF,
    startAddr & 0xFF,
    (count >> 8) & 0xFF,
    count & 0xFF
  ];
  const crc = crc16Modbus(cmd);
  return Buffer.from([...cmd, ...crc]);
}

// Convert hex to ASCII
function hexToAscii(hexStr) {
  try {
    const bytes = Buffer.from(hexStr, 'hex');
    return bytes.toString('ascii').replace(/\0/g, ' ').trim();
  } catch (error) {
    return `(Invalid hex: ${hexStr})`;
  }
}

// Convert hex to signed integer
function getSignedValue(hexValue) {
  let value = parseInt(hexValue, 16);
  if (value > 32767) {
    value -= 65536;
  }
  return value;
}

// Parse device data
function parseDeviceData(hexResponse, deviceId) {
  if (!hexResponse.startsWith('0103')) {
    console.log('Invalid device response:', hexResponse);
    return null;
  }

  const dataLength = parseInt(hexResponse.slice(4, 6), 16);
  const dataPart = hexResponse.slice(6, 6 + dataLength * 2);
  const registers = [];
  for (let i = 0; i < dataPart.length; i += 4) {
    if (i + 4 <= dataPart.length) {
      registers.push(dataPart.slice(i, i + 4));
    }
  }

  const deviceData = { deviceId, timestamp: new Date().toISOString() };

  // System Information
  if (registers.length > 7) {
    deviceData.deviceModelHex = registers.slice(3, 8).join('');
    deviceData.deviceModelAscii = hexToAscii(deviceData.deviceModelHex);
  }
  if (registers.length > 2) {
    deviceData.firmwareVersion = registers[2];
  }
  if (registers.length > 8) {
    deviceData.controllerVersion = registers[8];
  }
  if (registers.length > 68) {
    deviceData.upsMode = parseInt(registers[68], 16) === 0;
  }
  if (registers.length > 150) {
    const workModeIdx = parseInt(registers[150], 16);
    deviceData.workMode = workModeIdx >= 0 && workModeIdx < workModes.length
      ? workModes[workModeIdx]
      : `Unknown mode (${workModeIdx})`;
  }
  if (registers.length > 70) {
    deviceData.masterSlaveStatus = parseInt(registers[70], 16);
  }
  if (registers.length > 24) {
    const deviceTemp = (parseInt(registers[24], 16) - 1000) / 10.0;
    deviceData.temperatureCelsius = Number(deviceTemp.toFixed(1));
    deviceData.temperatureFahrenheit = Number((deviceTemp * 1.8 + 32).toFixed(1));
  }

  // Battery Information
  if (registers.length > 11) {
    deviceData.batteryVoltage = Number((parseInt(registers[11], 16) / 100.0).toFixed(2));
  }
  if (registers.length > 50) {
    deviceData.batteryChargePercentage = parseInt(registers[50], 16);
  }
  if (registers.length > 61) {
    const batteryPower = getSignedValue(registers[61]);
    deviceData.batteryPower = Math.abs(batteryPower);
    deviceData.batteryStatus = batteryPower < 0 ? 'Charging' : 'Discharging';
  }
  if (registers.length > 12) {
    deviceData.batteryCurrent = Number(Math.abs(getSignedValue(registers[12]) / 100.0).toFixed(2));
  }
  if (registers.length > 37) {
    const batteryType = parseInt(registers[37], 16);
    deviceData.batteryType = batteryType === 2 ? 'No Battery' : 'Present';
  }
  if (registers.length > 100) {
    const batteryModeIdx = parseInt(registers[100], 16);
    deviceData.batteryMode = batteryModeIdx >= 0 && batteryModeIdx < batteryModes.length
      ? batteryModes[batteryModeIdx]
      : `Unknown mode (${batteryModeIdx})`;
  }

  // AC Output
  if (registers.length > 13) {
    deviceData.acOutputVoltage = Number((parseInt(registers[13], 16) / 10.0).toFixed(1));
  }
  if (registers.length > 18) {
    deviceData.acOutputPower = parseInt(registers[18], 16);
  }
  if (registers.length > 16) {
    deviceData.acOutputFrequency = Number((parseInt(registers[16], 16) / 100.0).toFixed(2));
  }
  if (registers.length > 58) {
    deviceData.acOutputApparentPower = parseInt(registers[58], 16);
  }

  // AC Input (Grid)
  if (registers.length > 15) {
    deviceData.acInputVoltage = Number((parseInt(registers[15], 16) / 10.0).toFixed(1));
  }
  if (registers.length > 53) {
    deviceData.acInputPower = parseInt(registers[53], 16);
  }
  if (registers.length > 17) {
    deviceData.acInputFrequency = Number((parseInt(registers[17], 16) / 100.0).toFixed(2));
  }
  if (registers.length > 59) {
    const gridPower = getSignedValue(registers[59]);
    deviceData.gridPower = gridPower;
    deviceData.gridStatus = gridPower > 0 ? 'Importing' : 'Exporting';
  }

  // Load
  if (registers.length > 67) {
    deviceData.homeLoad = parseInt(registers[67], 16);
  }

  // PV (Solar) Input
  if (registers.length > 20) {
    deviceData.pv1Voltage = parseInt(registers[20], 16);
  }
  if (registers.length > 22) {
    deviceData.pv1Power = parseInt(registers[22], 16);
  }
  if (registers.length > 74) {
    const pv2Voltage = parseInt(registers[72], 16);
    const pv2Power = parseInt(registers[74], 16);
    if (pv2Voltage > 0) {
      deviceData.pv2Voltage = pv2Voltage;
      deviceData.pv2Power = pv2Power;
      deviceData.totalPvPower = deviceData.pv1Power + pv2Power;
    } else {
      deviceData.totalPvPower = deviceData.pv1Power;
    }
  }

  // Settings
  if (registers.length > 167) {
    const beepMode = parseInt(registers[167], 16);
    deviceData.beepMode = beepMode < 3
      ? ['Off', 'Auto Off', 'Always On'][beepMode]
      : `Unknown (${beepMode})`;
  }
  if (registers.length > 168) {
    const backlightMode = parseInt(registers[168], 16);
    deviceData.backlightMode = backlightMode < 2
      ? ['Auto Off', 'Always On'][backlightMode]
      : `Unknown (${backlightMode})`;
  }

  return deviceData;
}

// Parse battery cell data
function parseBatteryCells(hexResponse, deviceId) {
  if (!hexResponse.startsWith('0103')) {
    console.log('Invalid battery cell response:', hexResponse);
    return null;
  }

  const dataLength = parseInt(hexResponse.slice(4, 6), 16);
  const dataPart = hexResponse.slice(6, 6 + dataLength * 2);
  const registers = [];
  for (let i = 0; i < dataPart.length; i += 4) {
    if (i + 4 <= dataPart.length) {
      registers.push(dataPart.slice(i, i + 4));
    }
  }

  const cellData = {};
  let numCells = 0;
  let totalVoltage = 0;
  let minVoltage = 9999;
  let maxVoltage = 0;

  for (let i = 0; i < registers.length; i++) {
    const voltage = parseInt(registers[i], 16);
    if (voltage > 10 && voltage < 50000) {
      const cellVoltage = voltage / 1000.0;
      cellData[`Cell ${i + 1}`.padStart(8, ' ')] = cellVoltage;
      numCells++;
      totalVoltage += cellVoltage;
      minVoltage = Math.min(minVoltage, cellVoltage);
      maxVoltage = Math.max(maxVoltage, cellVoltage);
    }
  }

  if (numCells === 0) {
    return null;
  }

  const avgVoltage = totalVoltage / numCells;
  const voltageDiff = maxVoltage - minVoltage;

  return {
    deviceId,
    timestamp: new Date().toISOString(),
    numberOfCells: numCells,
    averageVoltage: Number(avgVoltage.toFixed(3)),
    minimumVoltage: Number(minVoltage.toFixed(3)),
    maximumVoltage: Number(maxVoltage.toFixed(3)),
    voltageDifference: Number(voltageDiff.toFixed(3)),
    cellVoltages: cellData
  };
}

// Calculate daily aggregates
function calculateDailyAggregates(data, fields) {
  if (!data.length) return {};
  const aggregates = {};
  fields.forEach(field => {
    const values = data
      .map(item => item[field])
      .filter(val => val != null && !isNaN(val));
    if (values.length) {
      aggregates[field] = {
        min: Number(Math.min(...values).toFixed(3)),
        max: Number(Math.max(...values).toFixed(3)),
        avg: Number((values.reduce((sum, val) => sum + val, 0) / values.length).toFixed(3))
      };
    }
  });
  return aggregates;
}

// Calculate total daily energy consumption (Wh)
function calculateDailyEnergyConsumption(data, date) {
  if (!data.length) return 0;

  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay = new Date(`${date}T23:59:59.999Z`);

  const filteredData = data
    .filter(item => item.homeLoad != null && !isNaN(item.homeLoad) && new Date(item.timestamp) >= startOfDay && new Date(item.timestamp) <= endOfDay)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let totalEnergyWh = 0;
  for (let i = 1; i < filteredData.length; i++) {
    const prev = filteredData[i - 1];
    const curr = filteredData[i];
    const timeDiffHours = (new Date(curr.timestamp) - new Date(prev.timestamp)) / (1000 * 3600);
    const avgPower = (prev.homeLoad + curr.homeLoad) / 2;
    totalEnergyWh += avgPower * timeDiffHours;
  }

  return Number(totalEnergyWh.toFixed(2));
}

// MQTT client handlers
client.on('connect', () => {
  console.log('Connected to MQTT broker');

  const subTopic = `reportApp/${DEVICE_ID}`;
  client.subscribe(subTopic, { qos: 1 }, (err) => {
    if (err) {
      console.error('Subscription error:', err);
      return;
    }
    console.log(`Subscribed to ${subTopic}`);

    // Request device info
    const pubTopic = `listenApp/${DEVICE_ID}`;
    const deviceCmd = getReadHexStr(0, 95);
    client.publish(pubTopic, deviceCmd, { qos: 1 }, (err) => {
      if (err) {
        console.error('Publish device info error:', err);
        return;
      }
      console.log(`Published device info command to ${pubTopic}: ${deviceCmd.toString('hex')}`);
    });

    // Request battery cell info
    const batteryCmd = getReadHexStr(250, 50);
    client.publish(pubTopic, batteryCmd, { qos: 1 }, (err) => {
      if (err) {
        console.error('Publish battery info error:', err);
        return;
      }
      console.log(`Published battery info command to ${pubTopic}: ${batteryCmd.toString('hex')}`);
    });
  });
});

client.on('message', (topic, payload) => {
  const hexPayload = payload.toString('hex').toLowerCase();
  console.log(`Received message on ${topic}: ${hexPayload}`);

  const deviceId = topic.split('/').pop();
  let responsePart = hexPayload;

  if (hexPayload.includes('2b2b2b2b')) {
    responsePart = hexPayload.split('2b2b2b2b')[1];
  }

  if (responsePart.startsWith('0103')) {
    if (responsePart.length < 300) {
      const batteryData = parseBatteryCells(responsePart, deviceId);
      if (batteryData) {
        latestBatteryCellData = batteryData;
        historicalData.batteryCellData.push(batteryData);
        console.log('Updated Battery Cell Data:', JSON.stringify(batteryData, null, 2));
      }
    } else {
      const deviceData = parseDeviceData(responsePart, deviceId);
      if (deviceData) {
        latestDeviceData = deviceData;
        historicalData.deviceData.push(deviceData);
        console.log('Updated Device Data:', JSON.stringify(deviceData, null, 2));
      }
    }
  }
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

client.on('close', () => {
  console.log('Disconnected from MQTT broker. Reconnecting...');
  setTimeout(() => client.reconnect(), 5000);
});

// Middleware to parse JSON bodies
app.use(express.json());

// API Endpoints
app.get('/device', (req, res) => {
  if (!latestDeviceData && !latestBatteryCellData) {
    return res.status(404).json({ error: 'No data available. Try requesting data first.' });
  }
  res.json({
    deviceData: latestDeviceData,
    batteryCellData: latestBatteryCellData
  });
});

app.post('/device/request', (req, res) => {
  if (!client.connected) {
    return res.status(503).json({ error: 'MQTT client not connected.' });
  }

  const pubTopic = `listenApp/${DEVICE_ID}`;
  const deviceCmd = getReadHexStr(0, 95);
  const batteryCmd = getReadHexStr(250, 50);

  client.publish(pubTopic, deviceCmd, { qos: 1 }, (err) => {
    if (err) {
      console.error('Publish device info error:', err);
      return res.status(500).json({ error: 'Failed to publish device request.' });
    }
    console.log(`Published device info command to ${pubTopic}: ${deviceCmd.toString('hex')}`);
  });

  client.publish(pubTopic, batteryCmd, { qos: 1 }, (err) => {
    if (err) {
      console.error('Publish battery info error:', err);
      return res.status(500).json({ error: 'Failed to publish battery request.' });
    }
    console.log(`Published battery info command to ${pubTopic}: ${batteryCmd.toString('hex')}`);
  });

  res.json({ message: 'Device and battery info requests sent successfully.' });
});

app.get('/device/history', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date parameter. Use YYYY-MM-DD format.' });
  }

  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay = new Date(`${date}T23:59:59.999Z`);

  const filteredDeviceData = historicalData.deviceData.filter(data =>
    new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
  );
  const filteredBatteryCellData = historicalData.batteryCellData.filter(data =>
    new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
  );

  const totalDailyEnergyConsumptionWh = calculateDailyEnergyConsumption(filteredDeviceData, date);

  res.json({
    deviceData: filteredDeviceData,
    batteryCellData: filteredBatteryCellData,
    totalDailyEnergyConsumptionWh
  });
});

app.get('/device/html', (req, res) => {
  const { date } = req.query;
  const deviceData = latestDeviceData || {};
  const batteryData = latestBatteryCellData || {};
  const na = '<i class="fas fa-exclamation-triangle text-yellow-500 mr-1"></i>N/A';

  // Generate cell voltages table
  let cellVoltagesTable = na;
  if (batteryData.cellVoltages) {
    cellVoltagesTable = `
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-gray-200">
            <th class="p-2 border">Cell</th>
            <th class="p-2 border">Điện áp (V)</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(batteryData.cellVoltages || {}).map(([cell, voltage]) => `
            <tr class="border">
              <td class="p-2">${cell}</td>
              <td class="p-2">${voltage.toFixed(3)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // Daily aggregates (if date is provided)
  let dailyAggregatesHtml = '';
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    const filteredDeviceData = historicalData.deviceData.filter(data =>
      new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
    );
    const filteredBatteryCellData = historicalData.batteryCellData.filter(data =>
      new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
    );

    const deviceAggregates = calculateDailyAggregates(filteredDeviceData, [
      'temperatureCelsius', 'acOutputVoltage', 'acInputVoltage', 'homeLoad', 'totalPvPower', 'gridPower'
    ]);
    const batteryAggregates = calculateDailyAggregates(filteredBatteryCellData, [
      'averageVoltage', 'minimumVoltage', 'maximumVoltage', 'voltageDifference'
    ]);

    const totalDailyEnergyConsumptionWh = calculateDailyEnergyConsumption(filteredDeviceData, date);

    dailyAggregatesHtml = `
      <h2 class="text-xl font-semibold text-gray-800 mt-6 mb-3 flex items-center">
        <i class="fas fa-chart-line text-blue-500 mr-2"></i> Thống kê ngày ${date}
      </h2>
      <div class="space-y-3">
        <p class="text-gray-700 flex items-center">
          <i class="fas fa-tachometer-alt text-purple-500 mr-2"></i>
          <strong>Tổng công suất tiêu thụ trong ngày:</strong> ${totalDailyEnergyConsumptionWh || 'N/A'} Wh
        </p>
        <p class="text-gray-700"><strong>Nhiệt độ (°C):</strong> Min: ${deviceAggregates.temperatureCelsius?.min || 'N/A'}, Max: ${deviceAggregates.temperatureCelsius?.max || 'N/A'}, Avg: ${deviceAggregates.temperatureCelsius?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp đầu ra (V):</strong> Min: ${deviceAggregates.acOutputVoltage?.min || 'N/A'}, Max: ${deviceAggregates.acOutputVoltage?.max || 'N/A'}, Avg: ${deviceAggregates.acOutputVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp đầu vào (V):</strong> Min: ${deviceAggregates.acInputVoltage?.min || 'N/A'}, Max: ${deviceAggregates.acInputVoltage?.max || 'N/A'}, Avg: ${deviceAggregates.acInputVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Công suất tiêu thụ (W):</strong> Min: ${deviceAggregates.homeLoad?.min || 'N/A'}, Max: ${deviceAggregates.homeLoad?.max || 'N/A'}, Avg: ${deviceAggregates.homeLoad?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Công suất PV (W):</strong> Min: ${deviceAggregates.totalPvPower?.min || 'N/A'}, Max: ${deviceAggregates.totalPvPower?.max || 'N/A'}, Avg: ${deviceAggregates.totalPvPower?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Công suất lấy lưới (W):</strong> Min: ${deviceAggregates.gridPower?.min || 'N/A'}, Max: ${deviceAggregates.gridPower?.max || 'N/A'}, Avg: ${deviceAggregates.gridPower?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp trung bình pin (V):</strong> Min: ${batteryAggregates.averageVoltage?.min || 'N/A'}, Max: ${batteryAggregates.averageVoltage?.max || 'N/A'}, Avg: ${batteryAggregates.averageVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp tối thiểu pin (V):</strong> Min: ${batteryAggregates.minimumVoltage?.min || 'N/A'}, Max: ${batteryAggregates.minimumVoltage?.max || 'N/A'}, Avg: ${batteryAggregates.minimumVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp tối đa pin (V):</strong> Min: ${batteryAggregates.maximumVoltage?.min || 'N/A'}, Max: ${batteryAggregates.maximumVoltage?.max || 'N/A'}, Avg: ${batteryAggregates.maximumVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Chênh lệch điện áp pin (V):</strong> Min: ${batteryAggregates.voltageDifference?.min || 'N/A'}, Max: ${batteryAggregates.voltageDifference?.max || 'N/A'}, Avg: ${batteryAggregates.voltageDifference?.avg || 'N/A'}</p>
      </div>
    `;
  }

  const html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Thông Tin Thiết Bị</title>
      <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
      <div class="bg-white p-6 rounded-lg shadow-lg w-full max-w-2xl">
        <h1 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
          <i class="fas fa-solar-panel text-blue-500 mr-2"></i> Thiết bị ${deviceData.deviceId || na}
        </h1>
        <div class="space-y-3">
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-thermometer-half text-red-500 mr-2"></i>
            Nhiệt độ: ${deviceData.temperatureCelsius != null ? `${deviceData.temperatureCelsius} °C` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-bolt text-yellow-500 mr-2"></i>
            Điện áp đầu ra: ${deviceData.acOutputVoltage != null ? `${deviceData.acOutputVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-plug text-green-500 mr-2"></i>
            Điện áp đầu vào: ${deviceData.acInputVoltage != null ? `${deviceData.acInputVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-tachometer-alt text-purple-500 mr-2"></i>
            Công suất tiêu thụ: ${deviceData.homeLoad != null ? `${deviceData.homeLoad} W` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-sun text-orange-500 mr-2"></i>
            Công suất PV: ${deviceData.totalPvPower != null ? `${deviceData.totalPvPower} W` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-exchange-alt text-teal-500 mr-2"></i>
            Công suất lấy lưới: ${deviceData.gridPower != null ? `${deviceData.gridPower} W` : na}
          </p>
        </div>
        <h2 class="text-xl font-semibold text-gray-800 mt-6 mb-3 flex items-center">
          <i class="fas fa-battery-full text-blue-500 mr-2"></i> Thông tin Pin
        </h2>
        <div class="space-y-3">
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-list-ol text-blue-500 mr-2"></i>
            Số lượng cell: ${batteryData.numberOfCells != null ? batteryData.numberOfCells : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-bolt text-blue-500 mr-2"></i>
            Điện áp trung bình: ${batteryData.averageVoltage != null ? `${batteryData.averageVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-arrow-down text-blue-500 mr-2"></i>
            Điện áp tối thiểu: ${batteryData.minimumVoltage != null ? `${batteryData.minimumVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-arrow-up text-blue-500 mr-2"></i>
            Điện áp tối đa: ${batteryData.maximumVoltage != null ? `${batteryData.maximumVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-balance-scale text-blue-500 mr-2"></i>
            Chênh lệch điện áp: ${batteryData.voltageDifference != null ? `${batteryData.voltageDifference} V` : na}
          </p>
          <div class="mt-4">
            <h3 class="text-lg font-medium text-gray-700 mb-2">Điện áp từng cell:</h3>
            ${cellVoltagesTable}
          </div>
        </div>
        ${dailyAggregatesHtml}
        <div class="mt-6 text-center">
          <a href="/device/request" class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
            <i class="fas fa-sync-alt mr-1"></i> Cập nhật dữ liệu
          </a>
        </div>
      </div>
    </body>
    </html>
  `;

  res.send(html);
});

// Start server
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});const express = require('express');
const mqtt = require('mqtt');

const app = express();
const PORT = 3000;

const MQTT_HOST = 'lesvr.suntcn.com';
const MQTT_PORT = 1886;
const MQTT_USER = 'appuser';
const MQTT_PASSWORD = 'app666';
const DEVICE_ID = 'H250326002';
const USER_ID = '123456';
const clientId = `android-${USER_ID}-${Date.now()}`;

const workModes = [
  'Uninterruptible Power Mode (UPS)',
  'Save Money Mode',
  'Sell Mode',
  'Smart Meter Mode',
  'WIFI CT Mode',
  'MESH CT Mode'
];

const batteryModes = [
  'User Defined',
  'Special Battery Pack',
  'No Battery'
];

// Cache for latest and historical data
let latestDeviceData = null;
let latestBatteryCellData = null;
const historicalData = { deviceData: [], batteryCellData: [] };

// MQTT client setup
const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  clientId,
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  clean: true
});

// Calculate CRC16 Modbus checksum
function crc16Modbus(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return [crc & 0xFF, crc >> 8];
}

// Create Modbus read command
function getReadHexStr(startAddr, count) {
  const cmd = [
    0x01,
    0x03,
    (startAddr >> 8) & 0xFF,
    startAddr & 0xFF,
    (count >> 8) & 0xFF,
    count & 0xFF
  ];
  const crc = crc16Modbus(cmd);
  return Buffer.from([...cmd, ...crc]);
}

// Convert hex to ASCII
function hexToAscii(hexStr) {
  try {
    const bytes = Buffer.from(hexStr, 'hex');
    return bytes.toString('ascii').replace(/\0/g, ' ').trim();
  } catch (error) {
    return `(Invalid hex: ${hexStr})`;
  }
}

// Convert hex to signed integer
function getSignedValue(hexValue) {
  let value = parseInt(hexValue, 16);
  if (value > 32767) {
    value -= 65536;
  }
  return value;
}

// Parse device data
function parseDeviceData(hexResponse, deviceId) {
  if (!hexResponse.startsWith('0103')) {
    console.log('Invalid device response:', hexResponse);
    return null;
  }

  const dataLength = parseInt(hexResponse.slice(4, 6), 16);
  const dataPart = hexResponse.slice(6, 6 + dataLength * 2);
  const registers = [];
  for (let i = 0; i < dataPart.length; i += 4) {
    if (i + 4 <= dataPart.length) {
      registers.push(dataPart.slice(i, i + 4));
    }
  }

  const deviceData = { deviceId, timestamp: new Date().toISOString() };

  // System Information
  if (registers.length > 7) {
    deviceData.deviceModelHex = registers.slice(3, 8).join('');
    deviceData.deviceModelAscii = hexToAscii(deviceData.deviceModelHex);
  }
  if (registers.length > 2) {
    deviceData.firmwareVersion = registers[2];
  }
  if (registers.length > 8) {
    deviceData.controllerVersion = registers[8];
  }
  if (registers.length > 68) {
    deviceData.upsMode = parseInt(registers[68], 16) === 0;
  }
  if (registers.length > 150) {
    const workModeIdx = parseInt(registers[150], 16);
    deviceData.workMode = workModeIdx >= 0 && workModeIdx < workModes.length
      ? workModes[workModeIdx]
      : `Unknown mode (${workModeIdx})`;
  }
  if (registers.length > 70) {
    deviceData.masterSlaveStatus = parseInt(registers[70], 16);
  }
  if (registers.length > 24) {
    const deviceTemp = (parseInt(registers[24], 16) - 1000) / 10.0;
    deviceData.temperatureCelsius = Number(deviceTemp.toFixed(1));
    deviceData.temperatureFahrenheit = Number((deviceTemp * 1.8 + 32).toFixed(1));
  }

  // Battery Information
  if (registers.length > 11) {
    deviceData.batteryVoltage = Number((parseInt(registers[11], 16) / 100.0).toFixed(2));
  }
  if (registers.length > 50) {
    deviceData.batteryChargePercentage = parseInt(registers[50], 16);
  }
  if (registers.length > 61) {
    const batteryPower = getSignedValue(registers[61]);
    deviceData.batteryPower = Math.abs(batteryPower);
    deviceData.batteryStatus = batteryPower < 0 ? 'Charging' : 'Discharging';
  }
  if (registers.length > 12) {
    deviceData.batteryCurrent = Number(Math.abs(getSignedValue(registers[12]) / 100.0).toFixed(2));
  }
  if (registers.length > 37) {
    const batteryType = parseInt(registers[37], 16);
    deviceData.batteryType = batteryType === 2 ? 'No Battery' : 'Present';
  }
  if (registers.length > 100) {
    const batteryModeIdx = parseInt(registers[100], 16);
    deviceData.batteryMode = batteryModeIdx >= 0 && batteryModeIdx < batteryModes.length
      ? batteryModes[batteryModeIdx]
      : `Unknown mode (${batteryModeIdx})`;
  }

  // AC Output
  if (registers.length > 13) {
    deviceData.acOutputVoltage = Number((parseInt(registers[13], 16) / 10.0).toFixed(1));
  }
  if (registers.length > 18) {
    deviceData.acOutputPower = parseInt(registers[18], 16);
  }
  if (registers.length > 16) {
    deviceData.acOutputFrequency = Number((parseInt(registers[16], 16) / 100.0).toFixed(2));
  }
  if (registers.length > 58) {
    deviceData.acOutputApparentPower = parseInt(registers[58], 16);
  }

  // AC Input (Grid)
  if (registers.length > 15) {
    deviceData.acInputVoltage = Number((parseInt(registers[15], 16) / 10.0).toFixed(1));
  }
  if (registers.length > 53) {
    deviceData.acInputPower = parseInt(registers[53], 16);
  }
  if (registers.length > 17) {
    deviceData.acInputFrequency = Number((parseInt(registers[17], 16) / 100.0).toFixed(2));
  }
  if (registers.length > 59) {
    const gridPower = getSignedValue(registers[59]);
    deviceData.gridPower = gridPower;
    deviceData.gridStatus = gridPower > 0 ? 'Importing' : 'Exporting';
  }

  // Load
  if (registers.length > 67) {
    deviceData.homeLoad = parseInt(registers[67], 16);
  }

  // PV (Solar) Input
  if (registers.length > 20) {
    deviceData.pv1Voltage = parseInt(registers[20], 16);
  }
  if (registers.length > 22) {
    deviceData.pv1Power = parseInt(registers[22], 16);
  }
  if (registers.length > 74) {
    const pv2Voltage = parseInt(registers[72], 16);
    const pv2Power = parseInt(registers[74], 16);
    if (pv2Voltage > 0) {
      deviceData.pv2Voltage = pv2Voltage;
      deviceData.pv2Power = pv2Power;
      deviceData.totalPvPower = deviceData.pv1Power + pv2Power;
    } else {
      deviceData.totalPvPower = deviceData.pv1Power;
    }
  }

  // Settings
  if (registers.length > 167) {
    const beepMode = parseInt(registers[167], 16);
    deviceData.beepMode = beepMode < 3
      ? ['Off', 'Auto Off', 'Always On'][beepMode]
      : `Unknown (${beepMode})`;
  }
  if (registers.length > 168) {
    const backlightMode = parseInt(registers[168], 16);
    deviceData.backlightMode = backlightMode < 2
      ? ['Auto Off', 'Always On'][backlightMode]
      : `Unknown (${backlightMode})`;
  }

  return deviceData;
}

// Parse battery cell data
function parseBatteryCells(hexResponse, deviceId) {
  if (!hexResponse.startsWith('0103')) {
    console.log('Invalid battery cell response:', hexResponse);
    return null;
  }

  const dataLength = parseInt(hexResponse.slice(4, 6), 16);
  const dataPart = hexResponse.slice(6, 6 + dataLength * 2);
  const registers = [];
  for (let i = 0; i < dataPart.length; i += 4) {
    if (i + 4 <= dataPart.length) {
      registers.push(dataPart.slice(i, i + 4));
    }
  }

  const cellData = {};
  let numCells = 0;
  let totalVoltage = 0;
  let minVoltage = 9999;
  let maxVoltage = 0;

  for (let i = 0; i < registers.length; i++) {
    const voltage = parseInt(registers[i], 16);
    if (voltage > 10 && voltage < 50000) {
      const cellVoltage = voltage / 1000.0;
      cellData[`Cell ${i + 1}`.padStart(8, ' ')] = cellVoltage;
      numCells++;
      totalVoltage += cellVoltage;
      minVoltage = Math.min(minVoltage, cellVoltage);
      maxVoltage = Math.max(maxVoltage, cellVoltage);
    }
  }

  if (numCells === 0) {
    return null;
  }

  const avgVoltage = totalVoltage / numCells;
  const voltageDiff = maxVoltage - minVoltage;

  return {
    deviceId,
    timestamp: new Date().toISOString(),
    numberOfCells: numCells,
    averageVoltage: Number(avgVoltage.toFixed(3)),
    minimumVoltage: Number(minVoltage.toFixed(3)),
    maximumVoltage: Number(maxVoltage.toFixed(3)),
    voltageDifference: Number(voltageDiff.toFixed(3)),
    cellVoltages: cellData
  };
}

// Calculate daily aggregates
function calculateDailyAggregates(data, fields) {
  if (!data.length) return {};
  const aggregates = {};
  fields.forEach(field => {
    const values = data
      .map(item => item[field])
      .filter(val => val != null && !isNaN(val));
    if (values.length) {
      aggregates[field] = {
        min: Number(Math.min(...values).toFixed(3)),
        max: Number(Math.max(...values).toFixed(3)),
        avg: Number((values.reduce((sum, val) => sum + val, 0) / values.length).toFixed(3))
      };
    }
  });
  return aggregates;
}

// Calculate total daily energy consumption (Wh)
function calculateDailyEnergyConsumption(data, date) {
  if (!data.length) return 0;

  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay = new Date(`${date}T23:59:59.999Z`);

  const filteredData = data
    .filter(item => item.homeLoad != null && !isNaN(item.homeLoad) && new Date(item.timestamp) >= startOfDay && new Date(item.timestamp) <= endOfDay)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let totalEnergyWh = 0;
  for (let i = 1; i < filteredData.length; i++) {
    const prev = filteredData[i - 1];
    const curr = filteredData[i];
    const timeDiffHours = (new Date(curr.timestamp) - new Date(prev.timestamp)) / (1000 * 3600);
    const avgPower = (prev.homeLoad + curr.homeLoad) / 2;
    totalEnergyWh += avgPower * timeDiffHours;
  }

  return Number(totalEnergyWh.toFixed(2));
}

// MQTT client handlers
client.on('connect', () => {
  console.log('Connected to MQTT broker');

  const subTopic = `reportApp/${DEVICE_ID}`;
  client.subscribe(subTopic, { qos: 1 }, (err) => {
    if (err) {
      console.error('Subscription error:', err);
      return;
    }
    console.log(`Subscribed to ${subTopic}`);

    // Request device info
    const pubTopic = `listenApp/${DEVICE_ID}`;
    const deviceCmd = getReadHexStr(0, 95);
    client.publish(pubTopic, deviceCmd, { qos: 1 }, (err) => {
      if (err) {
        console.error('Publish device info error:', err);
        return;
      }
      console.log(`Published device info command to ${pubTopic}: ${deviceCmd.toString('hex')}`);
    });

    // Request battery cell info
    const batteryCmd = getReadHexStr(250, 50);
    client.publish(pubTopic, batteryCmd, { qos: 1 }, (err) => {
      if (err) {
        console.error('Publish battery info error:', err);
        return;
      }
      console.log(`Published battery info command to ${pubTopic}: ${batteryCmd.toString('hex')}`);
    });
  });
});

client.on('message', (topic, payload) => {
  const hexPayload = payload.toString('hex').toLowerCase();
  console.log(`Received message on ${topic}: ${hexPayload}`);

  const deviceId = topic.split('/').pop();
  let responsePart = hexPayload;

  if (hexPayload.includes('2b2b2b2b')) {
    responsePart = hexPayload.split('2b2b2b2b')[1];
  }

  if (responsePart.startsWith('0103')) {
    if (responsePart.length < 300) {
      const batteryData = parseBatteryCells(responsePart, deviceId);
      if (batteryData) {
        latestBatteryCellData = batteryData;
        historicalData.batteryCellData.push(batteryData);
        console.log('Updated Battery Cell Data:', JSON.stringify(batteryData, null, 2));
      }
    } else {
      const deviceData = parseDeviceData(responsePart, deviceId);
      if (deviceData) {
        latestDeviceData = deviceData;
        historicalData.deviceData.push(deviceData);
        console.log('Updated Device Data:', JSON.stringify(deviceData, null, 2));
      }
    }
  }
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

client.on('close', () => {
  console.log('Disconnected from MQTT broker. Reconnecting...');
  setTimeout(() => client.reconnect(), 5000);
});

// Middleware to parse JSON bodies
app.use(express.json());

// API Endpoints
app.get('/device', (req, res) => {
  if (!latestDeviceData && !latestBatteryCellData) {
    return res.status(404).json({ error: 'No data available. Try requesting data first.' });
  }
  res.json({
    deviceData: latestDeviceData,
    batteryCellData: latestBatteryCellData
  });
});

app.post('/device/request', (req, res) => {
  if (!client.connected) {
    return res.status(503).json({ error: 'MQTT client not connected.' });
  }

  const pubTopic = `listenApp/${DEVICE_ID}`;
  const deviceCmd = getReadHexStr(0, 95);
  const batteryCmd = getReadHexStr(250, 50);

  client.publish(pubTopic, deviceCmd, { qos: 1 }, (err) => {
    if (err) {
      console.error('Publish device info error:', err);
      return res.status(500).json({ error: 'Failed to publish device request.' });
    }
    console.log(`Published device info command to ${pubTopic}: ${deviceCmd.toString('hex')}`);
  });

  client.publish(pubTopic, batteryCmd, { qos: 1 }, (err) => {
    if (err) {
      console.error('Publish battery info error:', err);
      return res.status(500).json({ error: 'Failed to publish battery request.' });
    }
    console.log(`Published battery info command to ${pubTopic}: ${batteryCmd.toString('hex')}`);
  });

  res.json({ message: 'Device and battery info requests sent successfully.' });
});

app.get('/device/history', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date parameter. Use YYYY-MM-DD format.' });
  }

  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay = new Date(`${date}T23:59:59.999Z`);

  const filteredDeviceData = historicalData.deviceData.filter(data =>
    new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
  );
  const filteredBatteryCellData = historicalData.batteryCellData.filter(data =>
    new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
  );

  const totalDailyEnergyConsumptionWh = calculateDailyEnergyConsumption(filteredDeviceData, date);

  res.json({
    deviceData: filteredDeviceData,
    batteryCellData: filteredBatteryCellData,
    totalDailyEnergyConsumptionWh
  });
});

app.get('/device/html', (req, res) => {
  const { date } = req.query;
  const deviceData = latestDeviceData || {};
  const batteryData = latestBatteryCellData || {};
  const na = '<i class="fas fa-exclamation-triangle text-yellow-500 mr-1"></i>N/A';

  // Generate cell voltages table
  let cellVoltagesTable = na;
  if (batteryData.cellVoltages) {
    cellVoltagesTable = `
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-gray-200">
            <th class="p-2 border">Cell</th>
            <th class="p-2 border">Điện áp (V)</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(batteryData.cellVoltages || {}).map(([cell, voltage]) => `
            <tr class="border">
              <td class="p-2">${cell}</td>
              <td class="p-2">${voltage.toFixed(3)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // Daily aggregates (if date is provided)
  let dailyAggregatesHtml = '';
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    const filteredDeviceData = historicalData.deviceData.filter(data =>
      new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
    );
    const filteredBatteryCellData = historicalData.batteryCellData.filter(data =>
      new Date(data.timestamp) >= startOfDay && new Date(data.timestamp) <= endOfDay
    );

    const deviceAggregates = calculateDailyAggregates(filteredDeviceData, [
      'temperatureCelsius', 'acOutputVoltage', 'acInputVoltage', 'homeLoad', 'totalPvPower', 'gridPower'
    ]);
    const batteryAggregates = calculateDailyAggregates(filteredBatteryCellData, [
      'averageVoltage', 'minimumVoltage', 'maximumVoltage', 'voltageDifference'
    ]);

    const totalDailyEnergyConsumptionWh = calculateDailyEnergyConsumption(filteredDeviceData, date);

    dailyAggregatesHtml = `
      <h2 class="text-xl font-semibold text-gray-800 mt-6 mb-3 flex items-center">
        <i class="fas fa-chart-line text-blue-500 mr-2"></i> Thống kê ngày ${date}
      </h2>
      <div class="space-y-3">
        <p class="text-gray-700 flex items-center">
          <i class="fas fa-tachometer-alt text-purple-500 mr-2"></i>
          <strong>Tổng công suất tiêu thụ trong ngày:</strong> ${totalDailyEnergyConsumptionWh || 'N/A'} Wh
        </p>
        <p class="text-gray-700"><strong>Nhiệt độ (°C):</strong> Min: ${deviceAggregates.temperatureCelsius?.min || 'N/A'}, Max: ${deviceAggregates.temperatureCelsius?.max || 'N/A'}, Avg: ${deviceAggregates.temperatureCelsius?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp đầu ra (V):</strong> Min: ${deviceAggregates.acOutputVoltage?.min || 'N/A'}, Max: ${deviceAggregates.acOutputVoltage?.max || 'N/A'}, Avg: ${deviceAggregates.acOutputVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp đầu vào (V):</strong> Min: ${deviceAggregates.acInputVoltage?.min || 'N/A'}, Max: ${deviceAggregates.acInputVoltage?.max || 'N/A'}, Avg: ${deviceAggregates.acInputVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Công suất tiêu thụ (W):</strong> Min: ${deviceAggregates.homeLoad?.min || 'N/A'}, Max: ${deviceAggregates.homeLoad?.max || 'N/A'}, Avg: ${deviceAggregates.homeLoad?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Công suất PV (W):</strong> Min: ${deviceAggregates.totalPvPower?.min || 'N/A'}, Max: ${deviceAggregates.totalPvPower?.max || 'N/A'}, Avg: ${deviceAggregates.totalPvPower?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Công suất lấy lưới (W):</strong> Min: ${deviceAggregates.gridPower?.min || 'N/A'}, Max: ${deviceAggregates.gridPower?.max || 'N/A'}, Avg: ${deviceAggregates.gridPower?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp trung bình pin (V):</strong> Min: ${batteryAggregates.averageVoltage?.min || 'N/A'}, Max: ${batteryAggregates.averageVoltage?.max || 'N/A'}, Avg: ${batteryAggregates.averageVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp tối thiểu pin (V):</strong> Min: ${batteryAggregates.minimumVoltage?.min || 'N/A'}, Max: ${batteryAggregates.minimumVoltage?.max || 'N/A'}, Avg: ${batteryAggregates.minimumVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Điện áp tối đa pin (V):</strong> Min: ${batteryAggregates.maximumVoltage?.min || 'N/A'}, Max: ${batteryAggregates.maximumVoltage?.max || 'N/A'}, Avg: ${batteryAggregates.maximumVoltage?.avg || 'N/A'}</p>
        <p class="text-gray-700"><strong>Chênh lệch điện áp pin (V):</strong> Min: ${batteryAggregates.voltageDifference?.min || 'N/A'}, Max: ${batteryAggregates.voltageDifference?.max || 'N/A'}, Avg: ${batteryAggregates.voltageDifference?.avg || 'N/A'}</p>
      </div>
    `;
  }

  const html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Thông Tin Thiết Bị</title>
      <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
      <div class="bg-white p-6 rounded-lg shadow-lg w-full max-w-2xl">
        <h1 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
          <i class="fas fa-solar-panel text-blue-500 mr-2"></i> Thiết bị ${deviceData.deviceId || na}
        </h1>
        <div class="space-y-3">
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-thermometer-half text-red-500 mr-2"></i>
            Nhiệt độ: ${deviceData.temperatureCelsius != null ? `${deviceData.temperatureCelsius} °C` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-bolt text-yellow-500 mr-2"></i>
            Điện áp đầu ra: ${deviceData.acOutputVoltage != null ? `${deviceData.acOutputVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-plug text-green-500 mr-2"></i>
            Điện áp đầu vào: ${deviceData.acInputVoltage != null ? `${deviceData.acInputVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-tachometer-alt text-purple-500 mr-2"></i>
            Công suất tiêu thụ: ${deviceData.homeLoad != null ? `${deviceData.homeLoad} W` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-sun text-orange-500 mr-2"></i>
            Công suất PV: ${deviceData.totalPvPower != null ? `${deviceData.totalPvPower} W` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-exchange-alt text-teal-500 mr-2"></i>
            Công suất lấy lưới: ${deviceData.gridPower != null ? `${deviceData.gridPower} W` : na}
          </p>
        </div>
        <h2 class="text-xl font-semibold text-gray-800 mt-6 mb-3 flex items-center">
          <i class="fas fa-battery-full text-blue-500 mr-2"></i> Thông tin Pin
        </h2>
        <div class="space-y-3">
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-list-ol text-blue-500 mr-2"></i>
            Số lượng cell: ${batteryData.numberOfCells != null ? batteryData.numberOfCells : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-bolt text-blue-500 mr-2"></i>
            Điện áp trung bình: ${batteryData.averageVoltage != null ? `${batteryData.averageVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-arrow-down text-blue-500 mr-2"></i>
            Điện áp tối thiểu: ${batteryData.minimumVoltage != null ? `${batteryData.minimumVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-arrow-up text-blue-500 mr-2"></i>
            Điện áp tối đa: ${batteryData.maximumVoltage != null ? `${batteryData.maximumVoltage} V` : na}
          </p>
          <p class="text-gray-700 flex items-center">
            <i class="fas fa-balance-scale text-blue-500 mr-2"></i>
            Chênh lệch điện áp: ${batteryData.voltageDifference != null ? `${batteryData.voltageDifference} V` : na}
          </p>
          <div class="mt-4">
            <h3 class="text-lg font-medium text-gray-700 mb-2">Điện áp từng cell:</h3>
            ${cellVoltagesTable}
          </div>
        </div>
        ${dailyAggregatesHtml}
        <div class="mt-6 text-center">
          <a href="/device/request" class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
            <i class="fas fa-sync-alt mr-1"></i> Cập nhật dữ liệu
          </a>
        </div>
      </div>
    </body>
    </html>
  `;

  res.send(html);
});

// Start server
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
