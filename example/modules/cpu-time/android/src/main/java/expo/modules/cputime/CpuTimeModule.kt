package expo.modules.cputime

import android.os.Process
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CpuTimeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CpuTime")

    // The process's CPU time across all its threads, in ms.
    Function("cpuMs") { Process.getElapsedCpuTime().toDouble() }
  }
}
