#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

#define IMGBUILDER 1
#include "/Users/nurupo/Desktop/dev/VCSPC-master/dependencies/include/blowfish/Blowfish.h"

namespace fs = std::filesystem;

namespace {

constexpr std::uint32_t kImgSectorSize = 2048;
constexpr std::size_t kDirEntrySize = 32;

struct ImgKey {
  std::string name;
  unsigned char bytes[24];
};

const ImgKey kKeys[] = {
    {"key0",
     {0x81, 0x45, 0x26, 0xFA, 0xDA, 0x7C, 0x6C, 0x11, 0x86, 0x93, 0xCC, 0x90,
      0x2B, 0xB7, 0xE2, 0x32, 0x10, 0x0F, 0x56, 0x9B, 0x02, 0x8A, 0x6C, 0x5F}},
    {"key1",
     {124, 216, 71, 196, 191, 42, 230, 227, 164, 92, 149, 92,
      214, 126, 96, 45, 11, 97, 63, 217, 62, 171, 41, 221}},
};

struct ImgEntry {
  std::string name;
  std::uint32_t sectorOffset = 0;
  std::uint32_t sectorSize = 0;
};

struct ParsedImg {
  bool encrypted = false;
  std::string keyName = "none";
  std::uint32_t entryCount = 0;
  std::vector<ImgEntry> entries;
};

std::uint32_t read_u32_le(const unsigned char* data) {
  return static_cast<std::uint32_t>(data[0]) |
         (static_cast<std::uint32_t>(data[1]) << 8) |
         (static_cast<std::uint32_t>(data[2]) << 16) |
         (static_cast<std::uint32_t>(data[3]) << 24);
}

std::string trim_name(const unsigned char* data, std::size_t size) {
  std::size_t end = 0;
  while (end < size && data[end] != 0) {
    ++end;
  }

  std::string name(reinterpret_cast<const char*>(data), end);
  std::replace(name.begin(), name.end(), '\\', '/');
  return name;
}

bool starts_with_ver2(const unsigned char* data, std::size_t size) {
  return size >= 4 && data[0] == 'V' && data[1] == 'E' && data[2] == 'R' && data[3] == '2';
}

std::vector<unsigned char> read_bytes(const fs::path& path, std::size_t count) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("failed to open input file");
  }

  std::vector<unsigned char> bytes(count);
  in.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(count));
  const std::streamsize got = in.gcount();
  bytes.resize(static_cast<std::size_t>(got));
  return bytes;
}

ParsedImg parse_img_header(const fs::path& imgPath) {
  ParsedImg parsed;

  auto header = read_bytes(imgPath, 8);
  if (header.size() < 8) {
    throw std::runtime_error("file is too small to be a valid IMG");
  }

  if (starts_with_ver2(header.data(), header.size())) {
    parsed.entryCount = read_u32_le(header.data() + 4);
  } else {
    bool foundKey = false;
    for (const auto& key : kKeys) {
      auto decrypted = header;
      CBlowFish blowfish(const_cast<unsigned char*>(key.bytes), 24);
      blowfish.Decrypt(decrypted.data(), decrypted.size(), CBlowFish::ECB);
      if (!starts_with_ver2(decrypted.data(), decrypted.size())) {
        continue;
      }

      header = std::move(decrypted);
      parsed.encrypted = true;
      parsed.keyName = key.name;
      parsed.entryCount = read_u32_le(header.data() + 4);
      foundKey = true;
      break;
    }

    if (!foundKey) {
      throw std::runtime_error("unsupported IMG header or unknown encryption key");
    }
  }

  const std::size_t dirBytes = static_cast<std::size_t>(parsed.entryCount) * kDirEntrySize;
  auto buffer = read_bytes(imgPath, 8 + dirBytes);
  if (buffer.size() < 8 + dirBytes) {
    throw std::runtime_error("file ended before directory table was fully read");
  }

  if (parsed.encrypted) {
    for (const auto& key : kKeys) {
      if (key.name != parsed.keyName) {
        continue;
      }

      CBlowFish blowfish(const_cast<unsigned char*>(key.bytes), 24);
      blowfish.Decrypt(buffer.data(), 8, CBlowFish::ECB);
      blowfish.Decrypt(buffer.data() + 8, dirBytes, CBlowFish::CBC);
      break;
    }
  }

  if (!starts_with_ver2(buffer.data(), buffer.size())) {
    throw std::runtime_error("directory header did not decode to VER2");
  }

  parsed.entries.reserve(parsed.entryCount);
  for (std::uint32_t i = 0; i < parsed.entryCount; ++i) {
    const std::size_t entryOffset = 8 + (static_cast<std::size_t>(i) * kDirEntrySize);
    const unsigned char* entry = buffer.data() + entryOffset;
    ImgEntry imgEntry;
    imgEntry.sectorOffset = read_u32_le(entry);
    imgEntry.sectorSize = read_u32_le(entry + 4);
    imgEntry.name = trim_name(entry + 8, 24);

    if (imgEntry.name.empty() || imgEntry.sectorSize == 0) {
      continue;
    }

    parsed.entries.push_back(std::move(imgEntry));
  }

  return parsed;
}

std::string lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

void extract_entries(const fs::path& imgPath, const fs::path& outDir, const ParsedImg& parsed) {
  std::ifstream in(imgPath, std::ios::binary);
  if (!in) {
    throw std::runtime_error("failed to reopen input IMG for extraction");
  }

  fs::create_directories(outDir);

  std::vector<char> fileBuffer;
  std::size_t extractedCount = 0;

  for (const auto& entry : parsed.entries) {
    const std::uint64_t byteOffset = static_cast<std::uint64_t>(entry.sectorOffset) * kImgSectorSize;
    const std::uint64_t byteSize = static_cast<std::uint64_t>(entry.sectorSize) * kImgSectorSize;
    const fs::path outputPath = outDir / fs::path(entry.name);

    if (outputPath.has_parent_path()) {
      fs::create_directories(outputPath.parent_path());
    }

    fileBuffer.assign(static_cast<std::size_t>(byteSize), 0);
    in.seekg(static_cast<std::streamoff>(byteOffset), std::ios::beg);
    in.read(fileBuffer.data(), static_cast<std::streamsize>(byteSize));
    const std::streamsize got = in.gcount();
    if (got <= 0) {
      std::cerr << "skip: failed to read " << entry.name << '\n';
      in.clear();
      continue;
    }

    std::ofstream out(outputPath, std::ios::binary);
    out.write(fileBuffer.data(), got);
    if (!out) {
      throw std::runtime_error("failed to write extracted file: " + outputPath.string());
    }

    ++extractedCount;
    std::cout << "extract: " << entry.name << " (" << got << " bytes)\n";
  }

  std::cout << "done: extracted " << extractedCount << " files to " << outDir << '\n';
}

void print_key_summary() {
  std::cout << "known VCS IMG keys:\n";
  for (const auto& key : kKeys) {
    std::cout << "  " << key.name << ": ";
    for (std::size_t i = 0; i < std::size(key.bytes); ++i) {
      std::printf("%02X", key.bytes[i]);
      if (i + 1 != std::size(key.bytes)) {
        std::cout << ' ';
      }
    }
    std::cout << '\n';
  }
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 2 || argc > 3) {
      std::cerr << "usage: vcs_img_extract <input.img> [output_dir]\n";
      return 1;
    }

    const fs::path imgPath = fs::path(argv[1]);
    const fs::path outDir = argc >= 3 ? fs::path(argv[2]) : imgPath.parent_path() / (imgPath.stem().string() + "_extract");

    const ParsedImg parsed = parse_img_header(imgPath);

    std::cout << "input: " << imgPath << '\n';
    std::cout << "mode: " << (parsed.encrypted ? "encrypted VER2" : "plain VER2") << '\n';
    std::cout << "key: " << parsed.keyName << '\n';
    std::cout << "entries: " << parsed.entries.size() << '\n';
    print_key_summary();

    extract_entries(imgPath, outDir, parsed);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << '\n';
    return 1;
  }
}
