import ExpoModulesCore

/// CPU time the app's process has used, user plus system, in ms: the benchmarks diff it around each step.
public class CpuTimeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CpuTime")
    Function("cpuMs") { () -> Double in
      var usage = rusage()
      getrusage(RUSAGE_SELF, &usage)
      let ms = { (time: timeval) in Double(time.tv_sec) * 1000 + Double(time.tv_usec) / 1000 }
      return ms(usage.ru_utime) + ms(usage.ru_stime)
    }
  }
}
