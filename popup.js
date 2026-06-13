const runtimeAPI = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', async () => {
    const btn    = document.getElementById('syncBtn');
    const status = document.getElementById('syncStatus');

    // Show last sync time if available
    const stored = await runtimeAPI.storage.local.get('driveLastSync');
    if (stored.driveLastSync) {
        status.textContent = `Last synced: ${new Date(stored.driveLastSync).toLocaleString()}`;
    }

    btn.addEventListener('click', async () => {
        btn.disabled     = true;
        btn.textContent  = 'Syncing…';
        status.textContent = '';
        status.classList.remove('error');

        try {
            const result = await runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_SYNC' });
            if (result.success) {
                const s = await runtimeAPI.storage.local.get('driveLastSync');
                status.textContent = `Synced at ${new Date(s.driveLastSync).toLocaleString()}`;
            } else if (result.error === 'auth_silent_fail') {
                status.textContent = 'Could not sign in silently — click again to sign in.';
                status.classList.add('error');
            } else {
                status.textContent = result.error || 'Sync failed.';
                status.classList.add('error');
            }
        } catch (e) {
            status.textContent = e.message || 'Sync failed.';
            status.classList.add('error');
        }

        btn.disabled    = false;
        btn.textContent = 'Sync to Google Drive';
    });
});
