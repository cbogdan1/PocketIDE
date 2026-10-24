# Moves $env:POCKETIDE_RECYCLE_PATH to the Recycle Bin without any UI.
# Exit codes: 0 recycled, 2 refused because Windows would delete it permanently, 1 any other failure.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PocketIdeRecycler {
  [ComImport, Guid("3ad05575-8857-4850-9277-11b85bdb8e09")]
  class FileOperation {}

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {}

  // Only the slots up to GetAnyOperationsAborted matter; unused ones just keep the vtable order.
  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOperation {
    uint Advise(IFileOperationProgressSink sink);
    void Unadvise(uint cookie);
    void SetOperationFlags(uint flags);
    void SetProgressMessage();
    void SetProgressDialog();
    void SetProperties();
    void SetOwnerWindow();
    void ApplyPropertiesToItem();
    void ApplyPropertiesToItems();
    void RenameItem();
    void RenameItems();
    void MoveItem();
    void MoveItems();
    void CopyItem();
    void CopyItems();
    void DeleteItem(IShellItem item, IFileOperationProgressSink sink);
    void DeleteItems();
    void NewItem();
    void PerformOperations();
    [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
  }

  [ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int hr);
    [PreserveSig] int PreRenameItem(uint flags, IntPtr item, IntPtr newName);
    [PreserveSig] int PostRenameItem(uint flags, IntPtr item, IntPtr newName, int hr, IntPtr created);
    [PreserveSig] int PreMoveItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName);
    [PreserveSig] int PostMoveItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName, int hr, IntPtr created);
    [PreserveSig] int PreCopyItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName);
    [PreserveSig] int PostCopyItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName, int hr, IntPtr created);
    [PreserveSig] int PreDeleteItem(uint flags, IntPtr item);
    [PreserveSig] int PostDeleteItem(uint flags, IntPtr item, int hr, IntPtr created);
    [PreserveSig] int PreNewItem(uint flags, IntPtr dest, IntPtr newName);
    [PreserveSig] int PostNewItem(uint flags, IntPtr dest, IntPtr newName, IntPtr template, uint attributes, int hr, IntPtr created);
    [PreserveSig] int UpdateProgress(uint total, uint done);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }

  class Sink : IFileOperationProgressSink {
    public bool WouldNuke;
    public bool Recycled;
    public int StartOperations() { return 0; }
    public int FinishOperations(int hr) { return 0; }
    public int PreRenameItem(uint flags, IntPtr item, IntPtr newName) { return 0; }
    public int PostRenameItem(uint flags, IntPtr item, IntPtr newName, int hr, IntPtr created) { return 0; }
    public int PreMoveItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName) { return 0; }
    public int PostMoveItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName, int hr, IntPtr created) { return 0; }
    public int PreCopyItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName) { return 0; }
    public int PostCopyItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName, int hr, IntPtr created) { return 0; }
    // The shell clears TSF_DELETE_RECYCLE_IF_POSSIBLE when the item can't go to the Recycle Bin
    // (network drive, bin disabled, too large); failing here cancels it instead of deleting permanently.
    public int PreDeleteItem(uint flags, IntPtr item) {
      if ((flags & 0x80) != 0) return 0;
      WouldNuke = true;
      return unchecked((int)0x80004004); // E_ABORT
    }
    // Success codes can be non-zero (COPYENGINE_S_*); `created` is the item's new home in the Recycle Bin.
    public int PostDeleteItem(uint flags, IntPtr item, int hr, IntPtr created) {
      Recycled = hr >= 0 && created != IntPtr.Zero;
      return 0;
    }
    public int PreNewItem(uint flags, IntPtr dest, IntPtr newName) { return 0; }
    public int PostNewItem(uint flags, IntPtr dest, IntPtr newName, IntPtr template, uint attributes, int hr, IntPtr created) { return 0; }
    public int UpdateProgress(uint total, uint done) { return 0; }
    public int ResetTimer() { return 0; }
    public int PauseTimer() { return 0; }
    public int ResumeTimer() { return 0; }
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr bindCtx, ref Guid iid, out IShellItem item);

  // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE
  const uint Flags = 0x4 | 0x10 | 0x40 | 0x400 | 0x80000 | 0x100000;

  public static int Recycle(string path) {
    Guid iid = typeof(IShellItem).GUID;
    IShellItem item;
    Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item));
    IFileOperation op = (IFileOperation)new FileOperation();
    op.SetOperationFlags(Flags);
    Sink sink = new Sink();
    op.DeleteItem(item, sink);
    try {
      op.PerformOperations();
    } catch (COMException) {
      if (!sink.WouldNuke) throw;
    }
    if (sink.WouldNuke) return 2;
    if (!sink.Recycled) throw new Exception("Windows did not move the item to the Recycle Bin.");
    return 0;
  }
}
'@

try {
  exit ([PocketIdeRecycler]::Recycle($env:POCKETIDE_RECYCLE_PATH))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
