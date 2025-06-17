const express = require('express');
const mqtt = require('mqtt');

const app = express();
const PORT = 3002;

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

// Cache for latest device data
let latestDeviceData = null;

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

  return deviceData;
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
    const deviceData = parseDeviceData(responsePart, deviceId);
    if (deviceData) {
      latestDeviceData = deviceData;
      console.log('Updated Device Data:', JSON.stringify(deviceData, null, 2));
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
  if (!latestDeviceData) {
    return res.status(404).json({ error: 'No device data available. Try requesting data first.' });
  }
  res.json(latestDeviceData);
});

app.post('/device/request', (req, res) => {
  if (!client.connected) {
    return res.status(503).json({ error: 'MQTT client not connected.' });
  }

  const pubTopic = `listenApp/${DEVICE_ID}`;
  const deviceCmd = getReadHexStr(0, 95);
  client.publish(pubTopic, deviceCmd, { qos: 1 }, (err) => {
    if (err) {
      console.error('Publish device info error:', err);
      return res.status(500).json({ error: 'Failed to publish request.' });
    }
    console.log(`Published device info command to ${pubTopic}: ${deviceCmd.toString('hex')}`);
    res.json({ message: 'Device info request sent successfully.' });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
