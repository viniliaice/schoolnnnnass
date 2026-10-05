import { InstallAppCard } from '../../components/pwa/InstallAppCard';
import { EnableNotificationsCard } from '../../components/pwa/EnableNotificationsCard';
import { listMyDevices } from '../../lib/db/notifications';
import { useRole } from '../../context/RoleContext';
import { useEffect, useState } from 'react';

/** Dedicated "Install App" destination from the teacher sidebar. */
export function TeacherInstallPage() {
  const { user } = useRole();
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (!user) return;
    listMyDevices(user.id)
      .then((devices) => setSubscribed(devices.some((d) => d.is_active)))
      .catch(() => setSubscribed(false));
  }, [user]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Install App</h1>
        <p className="mt-1 text-slate-500">
          MBK School works as an installed app on Android, iPhone, iPad, Windows, macOS and ChromeOS.
        </p>
      </div>
      <InstallAppCard alwaysVisible />
      <EnableNotificationsCard subscribed={subscribed} />
    </div>
  );
}
