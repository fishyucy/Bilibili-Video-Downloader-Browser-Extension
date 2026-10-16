// web-ext 配置：AMO 打包/签名时只带扩展本体，排除宿主二进制、测试样本等本机文件。
// （web-ext 不读 .gitignore，所以要在这里显式排除；这也是「本地实测过宿主」之后
//   仍能打出干净 xpi 的关键。）
// web-ext config: pack/sign only the extension itself, excluding host binaries, test
// samples and other local files. (web-ext does not honour .gitignore, so the exclusions
// must be spelled out here -- this keeps the xpi clean even after local host testing.)
export default {
    ignoreFiles: [
        'native-host',
        'native-host/**',
        'tests',
        'tests/**',
        '.git',
        '.git/**',
        '.gitignore',
        '.gitattributes',
        '.amo-upload-uuid',
        '.web-ext-config.mjs',
        'web-ext-artifacts/**',
        '*.xpi',
        '*.pem'
    ]
};
