import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "django-insecure-7h#k2@x!q9w$e4r5t6y7u8i9o0p-blogprod"  # EXPECT: S3 hardcoded-secret
DEBUG = True  # EXPECT: S5 debug-mode
ALLOWED_HOSTS = ["*"]  # EXPECT: S5 allowed-hosts-wildcard

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "blog",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]

CORS_ALLOW_ALL_ORIGINS = True  # EXPECT: S5 cors-wildcard
SESSION_COOKIE_SECURE = False  # EXPECT: S8 insecure-cookie

ROOT_URLCONF = "config.urls"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("DB_NAME", "blog"),
        "USER": os.environ.get("DB_USER", "blog"),
        "PASSWORD": os.environ.get("DB_PASSWORD"),  # SAFE: S3
        "HOST": os.environ.get("DB_HOST", "localhost"),
    }
}

PASSWORD_HASHERS = ["django.contrib.auth.hashers.Argon2PasswordHasher"]  # SAFE: S8
