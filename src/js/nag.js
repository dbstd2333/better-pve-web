// Skip the "No valid subscription" dialog: run the guarded command directly.

BP.feature('nag', ['Proxmox.Utils'], function () {
    Proxmox.Utils.checked_command = function (orig_cmd) {
        orig_cmd();
    };
});
