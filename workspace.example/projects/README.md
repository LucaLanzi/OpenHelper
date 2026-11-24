Projects live here, one TOML file each. Create them with:

    make add-project REPO=~/code/my-repo

Example:

    name = "billee"
    repos = ["~/code/fprime-billee"]
    languages = ["cpp", "cmake", "python"]
    docs = ["cppreference", "cmake", "python-stdlib", "fprime"]
    exclude = ["**/build-*/**"]
