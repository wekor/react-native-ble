cmake_minimum_required(VERSION 3.13)
project(reactnativeble)

set(CMAKE_CXX_STANDARD 20)
set(COMMON_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../common/cpp)

file(GLOB COMMON_SOURCES CONFIGURE_DEPENDS ${COMMON_DIR}/*.cpp)
add_library(reactnativeble SHARED OnLoad.cpp ${COMMON_SOURCES})
target_include_directories(reactnativeble PRIVATE ${COMMON_DIR})
target_compile_options(reactnativeble PRIVATE -Wall)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)

# 16 KB pages: required on Android 15+ devices that use them, and by Google Play. NDK 27 links for 4 KB by default.
target_link_options(reactnativeble PRIVATE "-Wl,-z,max-page-size=16384")

target_link_libraries(
  reactnativeble
  ReactAndroid::jsi
  ReactAndroid::reactnative
  fbjni::fbjni
  android
  log
)
