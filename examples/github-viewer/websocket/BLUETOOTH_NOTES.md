# Web Bluetooth Research Notes

## Can Web Bluetooth replace the WebSocket relay?

Short answer: not directly, but it could supplement it for specific use cases.

## Web Bluetooth Serial API

The **Web Serial API** (`navigator.serial`) allows a web page to communicate with serial devices. Combined with Bluetooth Serial Port Profile (SPP), this could theoretically allow direct device-to-device communication.

However:
- Web Serial requires **user gesture** to initiate `navigator.serial.requestPort()`
- Bluetooth SPP is not the same as Web Bluetooth GATT
- **Web Bluetooth** (`navigator.bluetooth`) uses BLE GATT profiles, not serial

## Web Bluetooth GATT Approach

A BLE GATT service could be set up where:
- The 3D viewer acts as a GATT **peripheral** (not possible in Web Bluetooth -- browsers can only be centrals)
- A phone app acts as a GATT peripheral, the viewer as central

This means the phone would need to run a BLE peripheral (custom app, not browser).

## Practical Assessment

| Approach | Feasible | Notes |
|----------|----------|-------|
| WebSocket via WiFi/LAN | Yes | Current approach, works great |
| Web Bluetooth central | Partial | Browser can scan/connect, but needs a BLE peripheral app on phone |
| Web Bluetooth peripheral | No | Browsers cannot act as BLE peripherals |
| Web Serial + BT SPP | No | Web Serial does not support Bluetooth serial natively |
| WebRTC peer-to-peer | Yes | Could work without relay, but complex setup |

## Recommendation

Stick with WebSocket for now. The LAN approach (`ws://192.168.x.x:PORT`) already works for phone control. If direct pairing without a relay is needed, **WebRTC DataChannels** with a signaling server would be the next step -- but the relay is simpler and more reliable.

## Future: WebRTC P2P

If the relay becomes a bottleneck:
1. Use the relay only for signaling (exchange SDP offers/answers)
2. Establish WebRTC DataChannel directly between controller and viewer
3. Route commands through the DataChannel instead of WebSocket
4. Relay server becomes optional after the P2P connection is established
