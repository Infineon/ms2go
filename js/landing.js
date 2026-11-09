'use strict';

document.getElementById('port-detect').addEventListener('click', async event => {
  event.preventDefault();
  const status = document.getElementById('port-status');

  if (!('serial' in navigator)) {
    status.textContent = 'Web Serial is not available in this browser.';
    return;
  }

  try {
    const port = await navigator.serial.requestPort({
      filters: [
        { usbVendorId: 0x058B, usbProductId: 0xABCD },
        { usbVendorId: 0x04B4, usbProductId: 0x0002 },
      ],
    });
    const info = port.getInfo();
    const vendor = info.usbVendorId ? `VID 0x${info.usbVendorId.toString(16).toUpperCase()}` : 'USB device';
    const product = info.usbProductId ? `PID 0x${info.usbProductId.toString(16).toUpperCase()}` : '';
    status.textContent = `Selected ${vendor} ${product}.`;
  } catch (error) {
    if (error.name !== 'NotFoundError' && error.name !== 'AbortError') {
      status.textContent = `Port detection failed: ${error.message}`;
    }
  }
});
