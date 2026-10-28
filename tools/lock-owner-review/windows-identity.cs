using System;
using System.Runtime.InteropServices;

// Read-only identity boundary: registry metadata only; no payload reads.
public static class PrismLockIdentityReview {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegOpenKeyEx(IntPtr key, string name, uint options, uint access, out IntPtr opened);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegQueryValueEx(IntPtr key, string name, IntPtr reserved, out uint type, IntPtr data, ref uint length);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);

  public static string HostRealm() {
    IntPtr key;
    // KEY_QUERY_VALUE | KEY_WOW64_64KEY. An absent key is not an absent value.
    int opened = RegOpenKeyEx(new IntPtr(unchecked((int)0x80000002)), @"SYSTEM\CurrentControlSet\Control", 0, 0x0101, out key);
    if (opened != 0) return "unknown:open-error-" + opened;
    try {
      uint type, length = 0;
      int queried = RegQueryValueEx(key, "ContainerType", IntPtr.Zero, out type, IntPtr.Zero, ref length);
      if (queried == 2) return "win32:kernel";
      if (queried == 0) return "unknown:container-value-present";
      return "unknown:query-error-" + queried;
    } finally { RegCloseKey(key); }
  }
}
